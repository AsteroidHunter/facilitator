// The board's folder picker (folder-picker.js) without a page: its moves
// against a made-up server, its dates and counts, the view it keeps, and the
// markup it draws for the panel (mocks A and B) and the drop (mock C). The
// sheet is read for the rules the mocks set: no purple, no accent, every
// class its own. No browser starts and no folder is read.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const FP = require(path.join(root, "folder-picker.js"));
const SHEET = readFileSync(path.join(root, "folder-picker.css"), "utf8");
const CODE = readFileSync(path.join(root, "folder-picker.js"), "utf8");

// a made-up home: robin's folders, with the dates and counts the server gives
const HOME = "/Users/robin";
const TREE = {
  [HOME]: ["Desktop", "Documents", "Downloads", "notes", "projects"],
  [HOME + "/Desktop"]: [], [HOME + "/Documents"]: ["letters"], [HOME + "/Documents/letters"]: [],
  [HOME + "/Downloads"]: [], [HOME + "/notes"]: ["daily", "ideas"], [HOME + "/notes/daily"]: [], [HOME + "/notes/ideas"]: [],
  [HOME + "/projects"]: ["garden-planner", "website"], [HOME + "/projects/garden-planner"]: [],
  [HOME + "/projects/website"]: ["assets", "pages"], [HOME + "/projects/website/assets"]: [], [HOME + "/projects/website/pages"]: [],
};
const NOW = new Date(2026, 9, 18, 14, 32).getTime();
const AT = new Date(2026, 9, 18, 9, 41).getTime() / 1000;
function server(over = {}){
  const tree = JSON.parse(JSON.stringify(TREE));
  const asked = [];
  const listing = p => {
    const rel = p === HOME ? [] : p.slice(HOME.length + 1).split("/");
    const trail = [{ name: "robin", path: HOME }];
    rel.forEach((n, i) => trail.push({ name: n, path: HOME + "/" + rel.slice(0, i + 1).join("/") }));
    return { machine: "this", path: p, name: p === HOME ? "robin" : rel.at(-1), short: p === HOME ? "~" : "~/" + rel.join("/"),
      top: HOME, parent: p === HOME ? null : p.slice(0, p.lastIndexOf("/")), trail, more: 0,
      unreadable: (over.unreadable || []).includes(p),
      dirs: (over.unreadable || []).includes(p) ? [] : tree[p].slice().sort().map(n => ({ name: n, path: p + "/" + n, modified: AT, items: tree[p + "/" + n].length })) };
  };
  async function ask(url, init){
    asked.push((init && init.method === "POST" ? "POST " : "") + url);
    const u = new URL(url, "http://board");
    if (u.pathname === "/machines")
      return over.machines || { ok: true, status: 200, json: { machines: [{ id: "this", name: "This Mac", kind: "computer", online: true, top: HOME, home: HOME, sep: "/",
        places: [{ id: "home", name: "robin", path: HOME }, { id: "desktop", name: "Desktop", path: HOME + "/Desktop" },
                 { id: "documents", name: "Documents", path: HOME + "/Documents" }, { id: "downloads", name: "Downloads", path: HOME + "/Downloads" }] }] } };
    if (u.pathname === "/dirs"){
      let p = u.searchParams.get("path") || HOME;
      if (p.startsWith("~")) p = HOME + p.slice(1);
      else if (!p.startsWith("/")) p = (u.searchParams.get("from") || HOME) + "/" + p;
      p = p.replace(/\/+$/, "") || "/";
      if (!(p === HOME || p.startsWith(HOME + "/"))) return { ok: false, status: 400, json: { error: "outside the home folder" } };
      if (!(p in tree)) return { ok: false, status: 400, json: { error: "no folder there" } };
      return { ok: true, status: 200, json: listing(p) };
    }
    if (u.pathname === "/mkdir"){
      const p = u.searchParams.get("path"), n = u.searchParams.get("name");
      if (n.includes("/")) return { ok: false, status: 400, json: { error: "a folder name cannot hold a slash" } };
      if (tree[p].includes(n)) return { ok: false, status: 400, json: { error: "a folder by that name is already here" } };
      tree[p].push(n); tree[p + "/" + n] = [];
      return { ok: true, status: 200, json: { ok: true, name: n, path: p + "/" + n } };
    }
    throw new Error("unexpected " + url);
  }
  return { ask, asked, tree };
}
const store = (seed = {}) => { const m = new Map(Object.entries(seed)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };
async function picker(opts = {}, over = {}){
  const s = server(over);
  const p = new FP.Picker(opts, { ask: s.ask, store: over.store || store(), now: () => NOW });
  await p.start();
  return { p, s };
}
const names = p => p.rows().map(r => r.name);
const strip = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// the column view's path bar alone, its two layers whole
const pathbarOf = html => (html.match(/<div class="fp-pathbar"><div class="fp-crumbs">[\s\S]*?<\/div><\/div>/) || [""])[0];

test("dates and counts read as the mocks write them", () => {
  assert.equal(FP.when(AT, NOW), "Today, 09:41");
  assert.equal(FP.when(new Date(2026, 9, 17, 18, 20).getTime() / 1000, NOW), "Yesterday, 18:20");
  assert.equal(FP.when(new Date(2026, 9, 16, 8, 0).getTime() / 1000, NOW), "16 Oct 2026");
  assert.equal(FP.whenShort(AT, NOW), "Today");
  assert.equal(FP.whenShort(new Date(2026, 8, 27).getTime() / 1000, NOW), "27 Sep");
  assert.equal(FP.whenShort(new Date(2025, 8, 27).getTime() / 1000, NOW), "27 Sep 2025");
  assert.equal(FP.when(undefined, NOW), "");
  assert.equal(FP.itemsText({ items: 18 }), "18 items");
  assert.equal(FP.itemsText({ items: 1 }), "1 item");
  assert.equal(FP.itemsText({ items: 9999, itemsCut: true }), "9999+ items");
  assert.equal(FP.itemsText({ items: null }), "");
});

test("it opens at home on this machine, with home's folders", async () => {
  const { p, s } = await picker();
  assert.deepEqual(s.asked, ["/machines", "/dirs?path=%2FUsers%2Frobin"]);
  assert.equal(p.at.path, HOME);
  assert.equal(p.place, "home");
  assert.deepEqual(names(p), ["Desktop", "Documents", "Downloads", "notes", "projects"]);
  assert.equal(p.off, false);
});

test("into a folder, Back up one, Forward down again, and any other move clears Forward", async () => {
  const { p } = await picker();
  await p.go(HOME + "/projects");
  await p.go(HOME + "/projects/website");
  assert.equal(p.at.short, "~/projects/website");
  await p.up();
  assert.equal(p.at.path, HOME + "/projects");
  await p.up();
  assert.equal(p.at.path, HOME);
  assert.equal(p.up(), null, "home is the top: no Back");
  assert.deepEqual(p.fwd, [HOME + "/projects/website", HOME + "/projects"]);
  await p.forward();
  assert.equal(p.at.path, HOME + "/projects");
  await p.go(HOME + "/notes");
  assert.deepEqual(p.fwd, []);
  assert.equal(await p.forward(), false);
});

test("a place stays on while the folder is inside it; outside it the machine is on", async () => {
  const { p } = await picker();
  await p.choosePlace("documents");
  assert.equal(p.place, "documents");
  await p.go(HOME + "/Documents/letters");
  assert.equal(p.place, "documents");
  await p.up(); await p.up();
  assert.equal(p.at.path, HOME);
  assert.equal(p.place, "this");
  await p.choosePlace("this");
  assert.equal(p.at.path, HOME);
  await p.go(HOME + "/notes");
  assert.equal(p.place, "this", "a machine's row stays on wherever it leads");
});

test("a typed path: ~, relative to the folder on show, and refusals in plain words", async () => {
  const { p } = await picker();
  await p.goTyped("~/projects");
  assert.equal(p.at.path, HOME + "/projects");
  await p.goTyped("website");
  assert.equal(p.at.path, HOME + "/projects/website");
  assert.equal(await p.goTyped("~/nope"), false);
  assert.equal(p.note, "No folder at ~/nope on This Mac");
  assert.equal(p.typed, "~/nope");
  assert.equal(p.at.path, HOME + "/projects/website", "a refusal leaves the folder on show");
  assert.match(p.drawPanel(), /class="fp-fld fp-bad" data-f="path" value="~\/nope"/);
  await p.goTyped("/etc");
  assert.equal(p.note, "/etc is outside your home folder");
  await p.go(HOME);
  assert.equal(p.note, ""); assert.equal(p.typed, null);
});

test("columns run from the first column to the folder on show, and a typed path starts them two above", async () => {
  const { p } = await picker({}, { store: store({ folderview: "columns" }) });
  assert.equal(p.view, "columns");
  assert.deepEqual(p.columns().map(c => c.path), [HOME]);
  await p.go(HOME + "/projects");
  await p.go(HOME + "/projects/website");
  assert.deepEqual(p.columns().map(c => [c.path, c.pick, !!c.listing]),
    [[HOME, HOME + "/projects", true], [HOME + "/projects", HOME + "/projects/website", true], [HOME + "/projects/website", null, true]]);
  await p.up();
  assert.deepEqual(p.columns().map(c => c.path), [HOME, HOME + "/projects"]);
  await p.choosePlace("documents");
  assert.deepEqual(p.columns().map(c => c.path), [HOME + "/Documents"]);
  await p.goTyped("~/projects/website/assets");
  assert.deepEqual(p.columns().map(c => c.path), [HOME + "/projects", HOME + "/projects/website", HOME + "/projects/website/assets"]);
  const html = p.drawPanel();
  assert.equal((html.match(/class="fp-col[ "]/g) || []).length, 3);
  assert.match(html, /class="fp-fr fp-cur"[^>]*>.*?website/);
  assert.match(html, /class="fp-pathbar"/);
  assert.equal(strip(pathbarOf(html)), "robin › projects › website › assets");
});

test("the view switch shows the chosen view, keeps the choice as the board's setting, and the list has its columns", async () => {
  const kept = store();
  const { p } = await picker({}, { store: kept });
  let html = p.drawPanel();
  assert.match(html, /<div class="fp-view" role="group" aria-label="View" data-on="list">/);
  assert.match(html, /class="fp-vs fp-on" data-a="view" data-v="list"/);
  assert.match(html, /class="fp-lh"><span class="fp-c-n">Name<\/span><span class="fp-c-d">Modified<\/span><span class="fp-c-c">Items<\/span>/);
  assert.match(strip(html), /notes Today, 09:41 2 items/);
  await p.setView("columns");
  assert.equal(kept.m.get(FP.VIEW_KEY), "columns");
  html = p.drawPanel();
  assert.match(html, /data-on="columns"/);
  assert.doesNotMatch(html, /fp-lh/);
  const again = await picker({}, { store: kept });
  assert.equal(again.p.view, "columns", "the last choice is remembered");
  assert.equal(FP.VIEW_KEY, "folderview");
});

test("the panel holds what mocks A and B hold, and the cross stands at the bar's right", async () => {
  const { p } = await picker();
  const html = p.drawPanel();
  const bar = html.slice(0, html.indexOf('<div class="fp-bd">'));
  const order = ['data-a="up"', 'data-a="fwd"', 'class="fp-view"', 'data-a="menu"', 'data-a="new"', 'class="fp-x"'].map(s => bar.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "the bar's order: " + order);
  assert.ok(bar.trimEnd().endsWith("</button></div>"), "nothing after the cross");
  assert.match(strip(html), /Places robin Desktop Documents Downloads Machines This Mac Name/);
  assert.doesNotMatch(html, /kestrel|lab-box|vega|offline/, "no made-up servers");
  assert.match(html, /<label for="fp-goto">Go to<\/label><input id="fp-goto" class="fp-fld" data-f="path" value="~"/);
  assert.match(html, /data-a="cancel">Cancel<\/button><button type="button" class="fp-btn fp-go" data-a="choose">Choose<\/button><\/div>$/);
  p.menu = "loc";
  await p.go(HOME + "/projects/website");
  p.menu = "loc";
  const menu = p.drawPanel().match(/<div class="fp-menu qn-glass" role="menu">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual(strip(menu).split(" "), ["website", "projects", "robin"]);
});

test("the location pop-up and the path bar name home and the folders down to the one on show, never the machine", async () => {
  const { p } = await picker({}, { store: store({ folderview: "columns" }) });
  const bar = () => { const html = p.drawPanel(); return html.slice(0, html.indexOf('<div class="fp-bd">')); };
  const menu = () => (bar().match(/<div class="fp-menu qn-glass" role="menu">([\s\S]*?)<\/div>/) || [])[1];
  const pathbar = () => pathbarOf(p.drawPanel());
  // at home: the button and its menu name home alone, with the house
  p.menu = "loc";
  assert.match(bar(), /data-a="menu"[^>]*><svg[^>]*><path d="M3 10\.5[^"]*"\/>.*?<span class="fp-nm">robin<\/span>/);
  assert.equal(strip(menu()), "robin");
  assert.equal((menu().match(/class="fp-mr/g) || []).length, 1);
  assert.equal(strip(pathbar()), "robin");
  // deeper down: the folder on show first, home last, and nothing past home
  await p.go(HOME + "/projects/website/assets");
  p.menu = "loc";
  assert.deepEqual([...menu().matchAll(/<span class="fp-nm">([^<]*)<\/span>/g)].map(m => m[1]), ["assets", "website", "projects", "robin"]);
  assert.deepEqual([...menu().matchAll(/data-t="(\d+)"/g)].map(m => p.targets[+m[1]]),
    [HOME + "/projects/website/assets", HOME + "/projects/website", HOME + "/projects", HOME]);
  assert.equal(strip(pathbar()), "robin › projects › website › assets");
  assert.equal((pathbar().match(/class="fp-crumb[ "]/g) || []).length, 4);
  for (const html of [bar(), pathbar()]){
    assert.doesNotMatch(html, /This Mac/);
    assert.doesNotMatch(html, /M20 16V7/, "the machine's mark");
  }
  // the sidebar keeps its Machines section
  assert.match(strip(p.drawPanel()), /Machines This Mac/);
  // before the first listing answers, the button names home, not the machine
  let answer;
  const s = server();
  const waiting = new FP.Picker({}, { ask: url => url === "/machines" ? s.ask(url) : new Promise(r => { answer = r; }), store: store(), now: () => NOW });
  const started = waiting.start();
  await new Promise(r => setImmediate(r));
  const early = waiting.drawPanel();
  const button = early.slice(early.indexOf('data-a="menu"'), early.indexOf("</button>", early.indexOf('data-a="menu"')));
  assert.match(button, /<span class="fp-nm">robin<\/span>/);
  assert.doesNotMatch(button, /This Mac|M20 16V7/);
  answer(await s.ask("/dirs?path=" + encodeURIComponent(HOME)));
  await started;
});

test("the drop holds what mock C holds", async () => {
  const { p } = await picker({ kind: "drop" });
  await p.go(HOME + "/projects");
  const html = p.drawDrop();
  assert.match(html, /^<div class="fp-titlebar"><span class="fp-title">Open a new folder<\/span><button type="button" class="fp-x"/);
  assert.match(html, /<div class="fp-mh"><button type="button" class="fp-mt fp-on" data-a="place" data-p="this" title="This Mac"><span>This Mac<\/span><\/button><\/div>/);
  assert.match(strip(html), /~ \/ projects/);
  assert.match(html, /data-a="edit" title="Type a path"/);
  assert.match(strip(html.slice(html.indexOf("fp-sc"))), /^[^]*?Home Desktop Documents Downloads/);
  assert.match(html, /class="fp-trow" data-a="goto" data-t="\d+">.*?<span class="fp-ttl">website<\/span><span class="fp-tmeta"><span class="fp-tage">2<\/span><span class="fp-teng">Today<\/span>/);
  assert.match(html, /class="fp-plus" data-a="new"/);
  assert.match(html, /<span>Opens<\/span><code>This Mac  ~\/projects<\/code>/);
  p.edit = true;
  assert.match(p.drawDrop(), /<input class="fp-fld" data-f="path" value="~\/projects"/);
});

test("New folder: a named row first, made only after the server checks the name, Escape makes nothing", async () => {
  const { p, s } = await picker();
  await p.go(HOME + "/projects");
  assert.equal(p.newFolder(), true);
  assert.deepEqual(names(p), ["garden-planner", "untitled folder", "website"]);
  assert.match(p.drawPanel(), /<div class="fp-fr fp-sel">.*?<input class="fp-rn" data-f="name" value="untitled folder"/);
  p.cancelName();
  assert.deepEqual(names(p), ["garden-planner", "website"]);
  assert.ok(!s.asked.some(a => a.startsWith("POST")), "nothing made");
  p.newFolder();
  assert.equal(await p.nameFolder("a/b"), false);
  assert.equal(p.note, "A folder name cannot hold a slash");
  assert.ok(p.naming, "the row stays to be named again");
  assert.equal(await p.nameFolder("website"), false);
  assert.equal(p.note, "A folder by that name is already here");
  assert.equal(await p.nameFolder("  sound-lab "), true);
  assert.ok(s.asked.includes("POST /mkdir?path=%2FUsers%2Frobin%2Fprojects&name=sound-lab"));
  assert.deepEqual(names(p), ["garden-planner", "sound-lab", "website"]);
  assert.equal(p.rows()[p.hot].name, "sound-lab", "the new folder is the one reached");
  assert.equal(p.naming, null);
  // a second untitled folder takes the next free name
  s.tree[HOME + "/projects"].push("untitled folder"); s.tree[HOME + "/projects/untitled folder"] = [];
  await p.go(HOME + "/projects");
  p.newFolder();
  assert.equal(p.naming.name, "untitled folder 2");
});

test("the arrows move over the folders and stop at the ends, and Choose answers the folder on show", async () => {
  const { p } = await picker();
  p.moveHot(1); assert.equal(p.hot, 0);
  p.moveHot(-1); assert.equal(p.hot, 0);
  for (let i = 0; i < 9; i++) p.moveHot(1);
  assert.equal(p.hot, 4);
  await p.openRow(p.hot);
  assert.equal(p.at.path, HOME + "/projects");
  assert.equal(p.hot, -1);
  p.moveHot(-1); assert.equal(p.hot, 1, "Up from none reaches the last");
  assert.deepEqual(await p.choose(), { machine: "this", path: HOME + "/projects", name: "projects", short: "~/projects" });
});

test("a page's choose can answer words, which show with the picker kept open", async () => {
  const seen = [];
  const { p } = await picker({ kind: "drop", choose: async f => { seen.push(f.path); return seen.length === 1 ? "that folder is already open as notes" : null; } });
  await p.go(HOME + "/notes");
  assert.equal(await p.choose(), null);
  assert.equal(p.note, "That folder is already open as notes");
  assert.match(p.drawDrop(), /<div class="fp-err" role="alert">That folder is already open as notes<\/div>/);
  assert.equal((await p.choose()).path, HOME + "/notes");
  assert.deepEqual(seen, [HOME + "/notes", HOME + "/notes"]);
});

test("a folder the board may not read shows a short message, and a board that does not answer says so", async () => {
  const { p } = await picker({}, { unreadable: [HOME + "/Desktop"] });
  await p.choosePlace("desktop");
  assert.equal(p.at.unreadable, true);
  assert.match(strip(p.drawPanel()), /Desktop cannot be read The board may not look inside this folder\./);
  assert.equal(p.newFolder(), false);
  const old = await picker({}, { machines: { ok: false, status: 404, json: { error: "not found" } } });
  assert.equal(old.p.failed, "The folder picker needs the board's server restarted.");
  assert.equal(old.p.off, true);
  assert.match(old.p.drawPanel(), /needs the board&#39;s server restarted/);
});

test("both drawings stand before anything has answered, and say a slow listing is on its way", async () => {
  let answer;
  const ask = url => url === "/machines" ? server().ask(url) : new Promise(r => { answer = r; });
  for (const kind of ["panel", "drop"]) {
    const p = new FP.Picker({ kind }, { ask, store: store(), now: () => NOW });
    const draw = () => kind === "drop" ? p.drawDrop() : p.drawPanel();
    assert.doesNotThrow(draw, "drawn before the machines answer");
    const started = p.start();
    await new Promise(r => setImmediate(r));
    assert.doesNotThrow(draw, "drawn while the first listing is out");
    assert.equal(p.off, true);
    await new Promise(r => setTimeout(r, 200));
    assert.match(draw(), /<div class="fp-ld"><span class="fp-spin">\|<\/span>Reading folders on This Mac<\/div>/);
    answer({ ok: true, status: 200, json: { machine: "this", path: HOME, name: "robin", short: "~", top: HOME, parent: null,
      trail: [{ name: "robin", path: HOME }], dirs: [], more: 0, unreadable: false } });
    await started;
    assert.match(draw(), /No folders inside robin/);
  }
});

test("names and paths are written as text, never as markup", async () => {
  const { p, s } = await picker();
  s.tree[HOME].push('<img src=x onerror="alert(1)">'); s.tree[HOME + '/<img src=x onerror="alert(1)">'] = [];
  await p.go(HOME);
  assert.doesNotMatch(p.drawPanel(), /<img/);
  assert.doesNotMatch(p.drawDrop(), /<img/);
  // the count of folders left out is drawn only as a number
  p.at = { ...p.at, more: '<img src=x onerror="alert(1)">' };
  assert.doesNotMatch(p.drawPanel() + p.drawDrop(), /<img|more folders/);
});

test("a listing the server stopped short says not every folder is listed", async () => {
  const { p } = await picker({ kind: "drop" });
  p.at = { ...p.at, more: 18000 };
  assert.match(p.drawDrop(), /<div class="fp-empty">18000 more folders here are not listed<\/div>/);
  assert.match(strip(p.drawPanel()), /18000 more folders here are not listed/);
  p.at = { ...p.at, more: 0, cut: true };
  assert.match(p.drawDrop(), /<div class="fp-empty">Not every folder here is listed<\/div>/);
  assert.match(p.drawPanel(), /<div class="fp-note">Not every folder here is listed<\/div>/);
  p.at = { ...p.at, cut: false };
  assert.doesNotMatch(p.drawPanel() + p.drawDrop(), /folders here are not listed|Not every folder/);
});

test("the sheet and the code keep the house rules: no purple, no accent, no dashes, every class the picker's own", () => {
  for (const text of [SHEET, CODE]){
    assert.doesNotMatch(text, /--accent|#432BFF|purple|violet/i);
    assert.doesNotMatch(text, /[–—]/, "no en or em dash");
  }
  const rules = SHEET.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = new Set([...rules.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  for (const c of classes) assert.ok(c.startsWith("fp") || c === "qn-glass", "a class not the picker's own: " + c);
  // the literal start of every class the markup is written with, and every
  // class the script puts on its two layers
  const drawn = new Set([...CODE.matchAll(/class="([\w -]+)/g), ...CODE.matchAll(/className = "([\w -]+)/g)]
    .flatMap(m => m[1].split(/\s+/)).filter(Boolean));
  assert.ok(drawn.size > 40, "the scan found the drawing");
  for (const c of drawn) assert.ok(c === "fp" || c.startsWith("fp-") || c === "qn-glass", "drawn with a class not its own: " + c);
  // the panel's size as a share of the 1440 by 900 board, centred under the bar
  assert.match(SHEET, /\.fp-a\{left:0; right:0; top:41px; bottom:0; margin:auto;\n\s+width:clamp\(600px, 55vw, calc\(100vw - 32px\)\); height:clamp\(380px, 52vh, calc\(100vh - 65px\)\)\}/);
  assert.equal(Math.round(792 / 1440 * 100), 55); assert.equal(Math.round(468 / 900 * 100), 52);
});
