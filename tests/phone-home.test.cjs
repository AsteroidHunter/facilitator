// the home page on the phone. the house heads the project list the capsule in
// the row of buttons opens, the way it heads the board's bar, with the board's
// own mark; a tap on it opens the board's own home page, the token panel from
// home-widgets.js and nothing else, and choosing any project in the list brings
// that project's board back. held here four
// ways: m.html's markup and sheet read as text; the page's own home block lifted
// out and run against a small DOM, with no browser; GET /tokens/daily and
// GET /limits on the bridge socket of a fixture server, refused without a
// session and served with one; and the page itself at an iPhone 13 mini's size (375 by 812, device
// scale 3, touch), signed in over that socket, driven by taps. every count is
// invented and HOME points into the fixture, so no real log is ever read
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");
const { boardState } = require("./phone-board-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const PHONE = read("m.html");
const BOARD = read("index.html");
const WIDGETS = read("home-widgets.js");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON ||
  execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASS = "FixtureHome7!";
const IPHONE_13_MINI = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const settle = async (ms = 0) => {
  if (ms) return new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
};
const day = back => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);

// every plain rule in the page's style blocks, comments stripped, as its
// selector list and its declarations, the way the drawer's tab test reads them
function rulesOf(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")),
    decls: Object.fromEntries(m[2].split(";").map(d => d.trim()).filter(Boolean).map(d => {
      const at = d.indexOf(":");
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    })),
  }));
}
function declsFor(rules, selector) {
  const out = {};
  for (const r of rules) if (r.selectors.includes(selector)) Object.assign(out, r.decls);
  return out;
}
const between = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `${from} is not on the page`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end > start, `${to} does not follow ${from}`);
  return text.slice(start, end);
};

// ---- the markup and the sheet ---------------------------------------------------------
test("the house heads the phone's project list, a row of the list with the board's own mark", () => {
  // no tab row across the top any more: the card is the first thing in the page
  assert.doesNotMatch(PHONE, /id="tabrow"|id="tabbar"/, "the old tab row is still in the page");
  assert.match(between(PHONE, '<div id="page">', "</main>"), /^<div id="page">\s*<main id="pane"/);
  // the capsule in the row of buttons opens the list
  const dock = between(PHONE, '<nav id="dock"', "</nav>");
  assert.match(dock, /<button id="projbtn"[^>]*aria-controls="projmenu"/, "the capsule does not open the list");
  const list = between(PHONE, '<div id="projmenu"', "<aside");
  const house = /<button id="homeico"[^>]*>([\s\S]*?)<\/button>/.exec(list);
  assert.ok(house, "the house is a button in the project list");
  assert.match(house[0], /class="projrow"/, "it wears the list's own rows' class");
  assert.match(house[0], /type="button"/);
  assert.match(house[0], /aria-label="Home"/);
  assert.match(house[0], /aria-pressed="false"/);
  // the board's own mark, stroke for stroke, ahead of its name
  const mark = /<button id="homeico"[^>]*>(<svg[\s\S]*?<\/svg>)/;
  assert.equal(mark.exec(list)[1], /<button id="homeico"[^>]*>(<svg[\s\S]*?<\/svg>)<\/button>/.exec(BOARD)[1],
    "the phone's house is not the board's");
  // at the head of the list, ahead of the projects
  assert.ok(list.indexOf('id="homeico"') < list.indexOf('<div id="projlist">'), "the house does not head the list");

  const rules = rulesOf(PHONE);
  // the house is a row of the list in every way: nothing of its own in the sheet
  assert.deepEqual(declsFor(rules, "#homeico"), {}, "the house sets something of its own");
  assert.equal(declsFor(rules, ".projrow")["min-height"], "44px");
});

test("the home page takes the card's place, holds the heading and the panels and keeps the card as it was", () => {
  // inside the pane, beside the card, its files brought in by script, never by a tag
  const pane = between(PHONE, '<main id="pane"', "</main>");
  assert.match(pane, /<section id="home" aria-label="Home"><div id="homestack">\s*<div id="homebrand"><span id="homemark" aria-hidden="true"><\/span><span id="homebrandcopy"><span id="homebrandname">Facilitator<\/span><span id="homeversion"><\/span><\/span><\/div>\s*<div id="homeplot"><\/div><div id="homelimits" hidden><\/div>\s*<\/div><\/section>/);
  assert.doesNotMatch(PHONE, /<script src="\/home-widgets\.js">/);
  assert.doesNotMatch(PHONE, /<link[^>]*home-widgets\.css/);
  const rules = rulesOf(PHONE);
  assert.equal(declsFor(rules, "#home").display, "none");
  const up = declsFor(rules, "body.home #home");
  assert.equal(up.display, "flex");
  assert.equal(up.position, "absolute");
  assert.equal(up.inset, "calc(-1 * var(--edge-drawn))", "the panel's edge lands on the card's own");
  // the card is hidden, not taken out of the layout, so it comes back as left
  assert.equal(declsFor(rules, "body.home #cards").visibility, "hidden");
  assert.equal(declsFor(rules, "body.home #empty").visibility, "hidden");
  const emptied = declsFor(rules, "body.home main");
  assert.equal(emptied.background, "transparent");
  assert.equal(emptied["box-shadow"], "none");
  // the chart lane keeps clear of the strips the menus are pulled from: the
  // app's margin and the panel's side, with its hairline, reach past the strip
  const edge = Number(/const EDGE = (\d+);\s+\/\/ how far in from an edge a pull may begin/.exec(PHONE)[1]);
  const inset = parseFloat(/--app-inset:([\d.]+)px/.exec(read("card-tokens.css"))[1]);
  const side = parseFloat(declsFor(rules, "#home .tk-panel")["padding-left"]);
  assert.equal(declsFor(rules, "#home .tk-panel")["padding-right"], side + "px");
  assert.ok(inset + side >= edge, `the lane starts ${inset + side}px in, inside the ${edge}px pull strip`);
  // no new colour in any rule of the house or the home page: the palette is
  // the board's through its variables, and the one literal allowed is the
  // opaque end of a fade, which is a mask and never drawn
  for (const r of rules.filter(r => r.selectors.some(s => /#home|#homeico/.test(s))))
    for (const [k, v] of Object.entries(r.decls)) {
      const where = `${r.selectors.join(", ")} sets ${k}: ${v}`;
      assert.doesNotMatch(v, /rgba?\(|hsla?\(/i, where);
      for (const hex of v.match(/#[0-9a-f]{3,8}\b/gi) || [])
        assert.ok(/mask-image$/.test(k) && hex === "#000", where);
    }
});

test("while home is up no project is checked, the capsule reads Home, the card is not read and the board's keys are off", () => {
  // a project chosen in the list leaves home; the list's own redraw never does
  const choose = between(PHONE, "function chooseRow(row){", "\n}\n");
  // the house is its own press: a tap on it in the list only shuts the list,
  // and never reaches the choice; the open project's own row lets go of the
  // card, but never while home is up
  assert.match(between(PHONE, 'projMenu.addEventListener("click", e => {', "});"),
    /if \(row === house\) closeProjects\(\);\n\s+else chooseRow\(row\);/);
  assert.doesNotMatch(choose, /house/);
  assert.match(choose, /if \(ow === activeOwner && !homeOpen [^\n]*\{ unselectShown\(\); return; \}\n\s+if \(homeOpen\) setHome\(false\);[^\n]*\n\s+setTab\(ow\);/);
  assert.doesNotMatch(between(PHONE, "function setTab(owner){", "\n}\n"), /setHome/);
  const paint = between(PHONE, "function renderTabs(st){", "\n}\n");
  assert.doesNotMatch(paint, /setHome/);
  assert.match(paint, /on = ow === activeOwner && !homeOpen/);
  assert.match(paint, /const name = homeOpen \? "Home" : labelOf\(st, activeOwner\);/);
  // shown is read, but a card under the home page is not shown
  assert.match(between(PHONE, "function select(id, opts){", "\n}\n"), /\n  if \(chosen && !homeOpen\) markSeen\(id\);\n/);
  // a card picked in the drawer, a card just made and a notification's card
  // are each shown on their board
  assert.match(between(PHONE, 'r.addEventListener("click", e => {', "});"), /if \(homeOpen\) setHome\(false\);[^\n]*\n\s+select\(b\.id\); closeDrawer\(\);/);
  assert.match(between(PHONE, "if (pendingFocus && els[pendingFocus]){", "\n  }\n"), /if \(homeOpen\) setHome\(false\);[^\n]*\n\s+select\(id\);/);
  assert.match(between(PHONE, "function goToBox(id){", "\n}\n"), /^function goToBox\(id\)\{\n  if \(homeOpen\) setHome\(false\);/);
  // the keys: only the diagnostic save answers on home
  assert.match(PHONE, /const homeShortcutActions = \{ diagnostic: phoneShortcutActions\.diagnostic \};/);
  assert.match(PHONE, /dispatchCardShortcut\(e, homeOpen \? homeShortcutActions : phoneShortcutActions\);/);
  // signing out forgets it with the open tab and card
  assert.match(PHONE, /\["pendops", "selbox", "activeproj", "homeopen"\]/);
});

// ---- the page's own home block, run against a small DOM --------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this._html = "";
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const list = {
      add: (...n) => { this.className = [...new Set([...names(), ...n])].join(" "); },
      remove: (...n) => { this.className = names().filter(x => !n.includes(x)).join(" "); },
      contains: n => names().includes(n),
      toggle: (n, on) => {
        const want = on === undefined ? !names().includes(n) : !!on;
        if (want) list.add(n); else list.remove(n);
        return want;
      },
    };
    return list;
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this._html = ""; this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = ""; this.children = []; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this }); }
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  querySelector(sel) { return (this.parts || {})[sel] || null; }
  querySelectorAll() { return []; }
}
const walk = (el, out = []) => { for (const c of el.children) { out.push(c); walk(c, out); } return out; };
function daysEnding(n) {
  return Array.from({ length: n }, (_, k) => ({ date: day(n - 1 - k), total: k % 3 ? 1e6 * k : 0 }));
}
function phoneHome({ stored = {}, want = null, serve = true, state = { rev: 1 }, index = "" } = {}) {
  const block = between(PHONE, "// ---- the home page ----", "// ---- the drawer's list");
  const doc = { listeners: {}, hidden: false };
  doc.createElement = tag => new El(tag, doc);
  doc.body = new El("body", doc);
  doc.head = new El("head", doc);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  const byId = {};
  for (const id of ["homeico", "homeplot", "homeversion", "homemark"]) byId[id] = new El(id === "homeico" ? "button" : "div", doc);
  doc.getElementById = id => byId[id] || null;
  const store = new Map(Object.entries(stored));
  const fetched = [], tabs = [], blurred = [], unselected = [], idle = [], timers = new Map();
  let nextTimer = 0;
  const ctx = {
    console, document: doc, homeOpen: false, lastState: state, wantBox: want,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
                    removeItem: k => store.delete(k) },
    renderTabs: st => tabs.push(st),
    dismissEditor: () => blurred.push(true),
    unselectShown: () => unselected.push(true),
    setInterval: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: id => { timers.delete(id); },
    requestIdleCallback: fn => { idle.push(fn); },
    fetch: async url => { fetched.push(url);
      return { ok: true, text: async () => index,
               json: async () => ({ days: daysEnding(371), found: { claude: true, codex: false } }) }; },
  };
  ctx.window = ctx;
  // appending the script is where a browser fetches it: here the real file
  // runs into the same sandbox, or fails the way an unreachable board does,
  // after the append returns, as a browser's load and error events come
  const net = { serve };
  doc.head.append = (...nodes) => {
    for (const n of nodes) {
      doc.head.appendChild(n);
      if (n.tagName !== "SCRIPT") continue;
      const ok = net.serve;
      setImmediate(() => { if (ok) { vm.runInContext(WIDGETS, ctx); n.onload(); } else n.onerror(); });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return { ctx, doc, byId, store, fetched, tabs, blurred, unselected, idle, timers, net, is: name => vm.runInContext(name, ctx) };
}

test("the phone's house opens home, fetches the widgets then, and leaving puts everything back", async () => {
  const h = phoneHome();
  const house = h.byId.homeico;
  assert.equal(h.doc.head.children.length, 0, "the block itself fetches nothing; the page's idle warm-up is the load handler's");
  house.click();
  assert.equal(h.ctx.homeOpen, true);
  assert.ok(h.doc.body.classList.contains("home"));
  assert.ok(house.classList.contains("on"), "the house is seated");
  assert.equal(house.getAttribute("aria-pressed"), "true");
  assert.equal(h.store.get("homeopen"), "1");
  assert.equal(h.blurred.length, 1, "the card's typing and its keyboard go with the card");
  assert.equal(h.unselected.length, 1, "the card on screen is unselected when home opens");
  assert.equal(h.tabs.length, 1, "the list and the capsule are drawn again with no project checked");
  await settle();
  const [sheet, script] = h.doc.head.children;
  assert.equal(sheet.href, "/home-widgets.css");
  assert.equal(script.src, "/home-widgets.js");
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371"]);
  const panel = h.byId.homeplot.children[0];
  assert.equal(panel.className, "tk-panel", "the board's own panel");
  const stage = walk(panel).find(n => n.className === "tk-stage");
  assert.equal((stage.innerHTML.match(/class="tk-day"/g) || []).length, 365);
  assert.equal([...h.timers.values()].filter(t => t.ms === 5 * 60 * 1000).length, 1, "asks again every five minutes");

  // the house is a place: pressing it again changes nothing
  house.click();
  await settle();
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371"]);

  // leaving, as choosing a project in the list does
  h.ctx.setHome(false);
  assert.equal(h.ctx.homeOpen, false);
  assert.ok(!h.doc.body.classList.contains("home"));
  assert.ok(!house.classList.contains("on"));
  assert.equal(house.getAttribute("aria-pressed"), "false");
  assert.equal(h.store.has("homeopen"), false);
  assert.equal(h.timers.size, 0, "no asking while home is shut");
  assert.equal(h.tabs.length, 2, "and the open project is checked again");

  // back again: the same panel, asked again, nothing fetched twice
  house.click();
  await settle();
  assert.equal(h.doc.head.children.length, 2);
  assert.equal(h.byId.homeplot.children.length, 1);
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371", "/tokens/daily?days=371"]);
});

test("a reopen comes back to home, except onto a notification's card, and a failed load says so and asks again", async () => {
  const back = phoneHome({ stored: { homeopen: "1" } });
  assert.equal(back.ctx.homeOpen, false);
  for (const fn of back.doc.listeners.DOMContentLoaded) fn();
  assert.equal(back.ctx.homeOpen, true);
  await settle();
  assert.deepEqual(back.fetched, ["/tokens/daily?days=371"]);
  // the heading's mark and version are asked for when idle too; they are no part of the warm-up
  const warm = h => h.idle.filter(fn => fn.name !== "brandAsk");
  assert.equal(warm(back).length, 0, "going straight onto home needs no idle warm-up");

  const card = phoneHome({ stored: { homeopen: "1" }, want: "m12" });
  for (const fn of card.doc.listeners.DOMContentLoaded) fn();
  assert.equal(card.ctx.homeOpen, false, "a notification's card is shown on its board");
  // the page warms the home files when it is idle, and opens nothing
  assert.equal(warm(card).length, 1);
  assert.equal(card.doc.head.children.length, 0);
  warm(card)[0]();
  await settle();
  assert.equal(card.doc.head.children.length, 2, "the sheet and the script came in");
  assert.equal(card.ctx.homeOpen, false);
  assert.deepEqual(card.fetched, [], "no counts are asked for until home opens");

  // the board out of reach: home says so, with no ellipsis, and no counts are asked for
  const away = phoneHome({ serve: false });
  away.byId.homeico.click();
  await settle();
  assert.equal(away.byId.homeplot.textContent, "The home page could not be loaded. Tap the house to try again.");
  assert.deepEqual(away.fetched, []);
  assert.equal(away.doc.head.children.filter(n => n.tagName === "SCRIPT").length, 0, "the failed script is taken back out");
  // back in reach, a press on the house asks again and draws the panel
  away.net.serve = true;
  away.byId.homeico.click();
  await settle();
  assert.equal(away.byId.homeplot.children[0].className, "tk-panel");
  assert.deepEqual(away.fetched, ["/tokens/daily?days=371"]);
  // once drawn, the house is a place again
  away.byId.homeico.click();
  await settle();
  assert.deepEqual(away.fetched, ["/tokens/daily?days=371"]);
});

test("the heading's version and mark are the board page's own, kept a day and not written in the phone page", async () => {
  const version = /id="npversion">(v\d+\.\d+\.\d+)</.exec(BOARD)[1];
  const mark = /id="npmark" src="(data:image\/png;base64,[^"]+)"/.exec(BOARD)[1];
  assert.doesNotMatch(PHONE, new RegExp(version.replace(/\./g, "\\.")), "the version is written in the phone page");
  assert.ok(!PHONE.includes(mark.slice(0, 80)), "the mark is written in the phone page");

  // nothing kept: the word stands alone until the board page has been read, once the phone is idle
  const first = phoneHome({ index: BOARD });
  for (const fn of first.doc.listeners.DOMContentLoaded) fn();
  assert.equal(first.byId.homeversion.textContent, "");
  assert.equal(first.byId.homemark.classList.contains("on"), false);
  const ask = first.idle.filter(fn => fn.name === "brandAsk");
  assert.equal(ask.length, 1, "asked for once, when idle");
  assert.deepEqual(first.fetched, [], "nothing is fetched before the phone is idle");
  await ask[0]();
  assert.deepEqual(first.fetched, ["/"]);
  assert.equal(first.byId.homeversion.textContent, version);
  assert.equal(first.byId.homemark.style.backgroundImage, `url("${mark}")`);
  assert.ok(first.byId.homemark.classList.contains("on"));
  const kept = JSON.parse(first.store.get("homebrand"));
  assert.deepEqual([kept.version, kept.mark], [version, mark]);

  // kept and fresh: drawn at once and not asked for again
  const again = phoneHome({ index: BOARD, stored: { homebrand: JSON.stringify({ ...kept, at: Date.now() - 3600e3 }) } });
  for (const fn of again.doc.listeners.DOMContentLoaded) fn();
  assert.equal(again.byId.homeversion.textContent, version);
  assert.ok(again.byId.homemark.classList.contains("on"));
  assert.equal(again.idle.filter(fn => fn.name === "brandAsk").length, 0, "a day's keep is not asked for again");

  // kept a day ago: drawn at once and asked for again when idle
  const old = phoneHome({ index: BOARD, stored: { homebrand: JSON.stringify({ ...kept, at: Date.now() - 25 * 3600e3 }) } });
  for (const fn of old.doc.listeners.DOMContentLoaded) fn();
  assert.equal(old.byId.homeversion.textContent, version);
  assert.equal(old.idle.filter(fn => fn.name === "brandAsk").length, 1);

  // a page that does not carry them, or cannot be had, leaves the heading as it is
  const bare = phoneHome({ index: "<html></html>" });
  for (const fn of bare.doc.listeners.DOMContentLoaded) fn();
  await bare.idle.find(fn => fn.name === "brandAsk")();
  assert.equal(bare.byId.homeversion.textContent, "");
  assert.equal(bare.store.has("homebrand"), false);
});

// ---- a fixture server with a bridge password and invented logs -------------------------
let fixture = null;
function claudeLine(id, date, [inp, cw, cr, out]) {
  return JSON.stringify({ type: "assistant", timestamp: date + "T12:00:00Z",
    message: { id, role: "assistant", content: [],
               usage: { input_tokens: inp, cache_creation_input_tokens: cw,
                        cache_read_input_tokens: cr, output_tokens: out } } });
}
async function request(port, route, headers = {}, method = "GET", body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, body });
  return { status: r.status, type: r.headers.get("content-type") || "", setCookie: r.headers.get("set-cookie"),
           text: await r.text() };
}

before(async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "facilitator-phone-home-"));
  const app = path.join(outer, "app"), home = path.join(outer, "home");
  fs.mkdirSync(app); fs.mkdirSync(home);
  const source = read("server.py");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  fs.writeFileSync(path.join(app, "server.py"), patched);
  copyBridgeFiles(app);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"])
    fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  fs.cpSync(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });
  fs.writeFileSync(path.join(app, "state.json"), JSON.stringify(boardState({ cards: 24, seed: 916, dir: outer })));
  // three days of invented Claude Code turns: 1115 today, 22 the day before, none before that
  const logs = path.join(home, ".claude", "projects", "invented");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "s.jsonl"), [claudeLine("msg_a", day(0), [10, 100, 1000, 5]),
    claudeLine("msg_b", day(1), [1, 1, 10, 10])].join("\n") + "\n");
  execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
  const port = await freePortPair();
  const env = { ...process.env, HOME: home, TZ: "UTC", FACILITATOR_TEST_PORT: String(port),
                FACILITATOR_LOG_DIR: path.join(outer, "logs") };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  // no codex on the fixture's path, so the limits route never starts one
  fs.mkdirSync(path.join(outer, "nobin")); env.PATH = path.join(outer, "nobin");
  const child = spawn(PYTHON, [path.join(app, "server.py")], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const s of [child.stdout, child.stderr]) { s.setEncoding("utf8"); s.on("data", c => { output += c; }); }
  fixture = { outer, port, bridge: port + 1, child };
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await request(port + 1, "/auth/check")).status === 200) break; } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await settle(25);
  }
  const origin = `http://127.0.0.1:${port + 1}`;
  const login = await request(port + 1, "/auth/login", { Origin: origin, "Content-Type": "application/json" },
                              "POST", JSON.stringify({ password: PASS }));
  assert.equal(login.status, 200, login.text);
  fixture.cookie = (login.setCookie || "").split(";")[0];
  assert.ok(fixture.cookie, "the fixture sign-in issued no session");
});

after(async () => {
  if (!fixture) return;
  if (fixture.child.exitCode === null) { fixture.child.kill("SIGTERM"); await once(fixture.child, "exit"); }
  await rm(fixture.outer, { recursive: true, force: true });
});

test("the bridge refuses /tokens/daily without a session and serves it with one", async () => {
  const { port, bridge, cookie } = fixture;
  const route = "/tokens/daily?days=371";
  for (const headers of [{}, { Cookie: "__Host-facilitator_session=not-a-session" }]) {
    const refused = await request(bridge, route, headers);
    assert.equal(refused.status, 401, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(refused.text), { error: "sign in required" });
    assert.doesNotMatch(refused.text, /days|total/, "a refusal carries no counts");
  }
  // the panel's own two files are gated the same way
  for (const file of ["/home-widgets.js", "/home-widgets.css"]) {
    assert.equal((await request(bridge, file)).status, 401, file);
    const served = await request(bridge, file, { Cookie: cookie });
    assert.equal(served.status, 200, file);
    assert.equal(served.text, read(file.slice(1)), file);
  }
  const served = await request(bridge, route, { Cookie: cookie });
  assert.equal(served.status, 200, served.text);
  assert.match(served.type, /^application\/json/);
  const answer = JSON.parse(served.text);
  assert.equal(answer.days.length, 371);
  assert.equal(answer.days.at(-1).date, day(0));
  assert.equal(answer.days.at(-1).total, 1115);
  assert.equal(answer.days.at(-2).total, 22);
  assert.equal(answer.total, 1137);
  assert.deepEqual(answer.found, { claude: true, codex: false });
  // the same reading the local socket gives the board
  assert.deepEqual(JSON.parse((await request(port, route)).text), answer);
  // a bad reading is refused the same way on the bridge as locally, after the gate
  assert.equal((await request(bridge, "/tokens/daily?days=0", { Cookie: cookie })).status, 400);
  // and a session that has been signed out is refused again
  const origin = `http://127.0.0.1:${bridge}`;
  const second = await request(bridge, "/auth/login", { Origin: origin, "Content-Type": "application/json" },
                               "POST", JSON.stringify({ password: PASS }));
  const gone = (second.setCookie || "").split(";")[0];
  assert.equal((await request(bridge, route, { Cookie: gone })).status, 200);
  assert.equal((await request(bridge, "/auth/logout", { Origin: origin, Cookie: gone }, "POST")).status, 200);
  assert.equal((await request(bridge, route, { Cookie: gone })).status, 401);
});

test("the bridge refuses /limits without a session and serves the numbers with one", async () => {
  const { outer, port, bridge, cookie } = fixture;
  const ahead = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(outer, "app", "claude-limits.json"), JSON.stringify({
    five_hour: { used_percentage: 12, resets_at: ahead }, seven_day: { used_percentage: 34, resets_at: ahead } }));
  for (const headers of [{}, { Cookie: "__Host-facilitator_session=not-a-session" }]) {
    const refused = await request(bridge, "/limits", headers);
    assert.equal(refused.status, 401, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(refused.text), { error: "sign in required" });
    assert.doesNotMatch(refused.text, /used|five_hour|weekly/, "a refusal carries no numbers");
  }
  const served = await request(bridge, "/limits", { Cookie: cookie });
  assert.equal(served.status, 200, served.text);
  assert.match(served.type, /^application\/json/);
  const answer = JSON.parse(served.text);
  const { fetched, now, refreshing, ...numbers } = answer;
  assert.deepEqual(numbers, { claude: { five_hour: { used: 12, resets: ahead }, weekly: { used: 34, resets: ahead } } });
  assert.equal(typeof now, "number");
  assert.ok(fetched <= now && now - fetched < 60, "when it was read, by the server's clock");
  assert.equal(refreshing, false, "nothing to renew: no codex on this server");
  const local = JSON.parse((await request(port, "/limits")).text);
  assert.deepEqual(local.claude, answer.claude);
});

// ---- the page at an iPhone 13 mini's size, over the bridge -------------------------------
test("on the phone the house in the project list opens home, the pill and the tips work by tap, and a project goes back", async () => {
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    userDataDir: path.join(fixture.outer, "chrome"), args: ["--disable-background-networking", "--no-first-run"] });
  try {
    const page = await browser.newPage();
    const problems = [];
    page.on("pageerror", e => problems.push("pageerror: " + e.message));
    page.on("console", m => {
      if (m.type() === "error" && !/fonts\.g(oogleapis|static)\.com/.test(m.text())) problems.push(m.text());
    });
    await page.setViewport(IPHONE_13_MINI);
    const origin = `http://127.0.0.1:${fixture.bridge}`;
    await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
    assert.equal(await page.evaluate(async pass => (await fetch("/auth/login", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pass }) })).status, PASS), 200);
    await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
    await page.waitForSelector("#projlist .projrow.on", { timeout: 5000 });

    // the capsule in the row along the bottom names the open project, its list
    // is shut, the house heads that list unchecked, and nothing is fetched yet
    const board = await page.evaluate(() => {
      const cap = document.getElementById("projbtn").getBoundingClientRect();
      return { capsule: { bottom: cap.bottom, height: cap.height },
               name: document.getElementById("projname").textContent,
               open: document.body.classList.contains("projopen"),
               rows: document.querySelectorAll("#projlist .projrow").length,
               first: document.querySelector("#projmenu .projrow").id,
               pressed: document.getElementById("homeico").getAttribute("aria-pressed"),
               checked: document.querySelectorAll("#projlist .projrow.on").length,
               home: getComputedStyle(document.getElementById("home")).display };
    });
    assert.ok(board.rows >= 2, "the fixture has projects");
    assert.equal(board.capsule.height, 48, "the capsule is not the bar's 48px");
    assert.equal(board.capsule.bottom, IPHONE_13_MINI.height - 10, "the capsule is not 10px off the bottom edge");
    assert.notEqual(board.name, "Home");
    assert.equal(board.open, false);
    assert.equal(board.first, "homeico", "the house does not head the list");
    assert.equal(board.pressed, "false");
    assert.equal(board.checked, 1);
    assert.equal(board.home, "none");
    // the page brings the home files in when it is idle, and opens nothing
    await page.waitForSelector("#homesheet", { timeout: 8000 });
    await page.waitForFunction(() => !!window.TokenWidgets, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains("home")), false);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#homeplot .tk-panel").length), 0, "no panel until home opens");

    // a tap on the capsule, then on the house: home, the board's own panel,
    // drawn from the bridge's /tokens/daily
    await page.tap("#projbtn");
    await page.waitForFunction(() => document.body.classList.contains("projopen"), { timeout: 3000 });
    await settle(300);
    await page.tap("#homeico");
    await page.waitForSelector("svg.tk-heat", { timeout: 10000 });
    const home = await page.evaluate(() => {
      // the card behind has older replies, whose arrows set their own visibility
      document.querySelector("#cards .box.sel")?.classList.add("hashist");
      const r = el => el.getBoundingClientRect();
      const scroll = document.querySelector(".tk-scroll"), panel = r(document.querySelector(".tk-panel"));
      const pane = r(document.getElementById("pane"));
      return { body: document.body.classList.contains("home"),
               pressed: document.getElementById("homeico").getAttribute("aria-pressed"),
               houseSeated: document.getElementById("homeico").classList.contains("on"),
               seated: document.querySelectorAll("#projlist .projrow.on").length,
               name: document.getElementById("projname").textContent,
               open: document.body.classList.contains("projopen"),
               days: document.querySelectorAll(".tk-day").length,
               sum: document.querySelector(".tk-sum").textContent,
               heading: document.querySelector(".tk-title").textContent,
               subtitle: !!document.querySelector(".tk-what"),
               panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
               pane: { left: pane.left, right: pane.right, top: pane.top },
               page: { top: r(document.getElementById("home")).top, bottom: r(document.getElementById("home")).bottom },
               brand: { top: r(document.getElementById("homebrand")).top, bottom: r(document.getElementById("homebrand")).bottom },
               versionBottom: r(document.getElementById("homeversion")).bottom,
               brandName: document.getElementById("homebrandname").textContent,
               limitsBottom: document.getElementById("homelimits").hidden ? null : r(document.getElementById("homelimits")).bottom,
               lane: { left: r(scroll).left, right: r(scroll).right },
               chartWidth: document.querySelector(".tk-chart svg").getBoundingClientRect().width,
               chart: { top: r(document.querySelector(".tk-chart svg")).top, bottom: r(document.querySelector(".tk-chart svg")).bottom },
               view: { top: r(document.querySelector(".tk-view")).top, bottom: r(document.querySelector(".tk-view")).bottom },
               rows: { top: Math.min(...[...document.querySelectorAll(".tk-day")].map(d => r(d).top)),
                       bottom: Math.max(...[...document.querySelectorAll(".tk-day")].map(d => r(d).bottom)) },
               head: r(document.querySelector(".tk-head")).bottom,
               foot: { top: r(document.querySelector(".tk-foot")).top, bottom: r(document.querySelector(".tk-foot")).bottom },
               panelBottom: panel.bottom,
               expected: TokenWidgets.geometry(r(document.querySelector(".tk-view")).height),
               atLatest: scroll.scrollLeft >= scroll.scrollWidth - scroll.clientWidth - 1 && scroll.scrollWidth > scroll.clientWidth,
               card: getComputedStyle(document.getElementById("cards")).visibility,
               cardParts: [...document.querySelectorAll("#cards *")].filter(n => getComputedStyle(n).visibility !== "hidden").length,
               hadHistory: !!document.querySelector("#cards .box.hashist"),
               composers: [...document.querySelectorAll(".compose")].filter(c =>
                 getComputedStyle(c).visibility === "visible" && c.getBoundingClientRect().width).length,
               lists: document.querySelectorAll("#home .trow").length };
    });
    assert.equal(home.body, true);
    assert.equal(home.pressed, "true");
    assert.equal(home.houseSeated, true, "the house is the one checked");
    assert.equal(home.seated, 0, "a project is checked on home");
    assert.equal(home.name, "Home", "the capsule does not read Home");
    assert.equal(home.open, false, "the list stayed open over home");
    assert.equal(home.days, 365);
    assert.match(home.sum, /^1\.14K tokens in the last year$/);
    assert.equal(home.heading, "Token consumption per day");
    assert.equal(home.subtitle, false, "no line under the heading");
    // the panel spans the pane, which is the screen within the app's margins
    assert.ok(Math.abs(home.panel.left - home.pane.left) < 1 && Math.abs(home.panel.right - home.pane.right) < 1);
    // the heading stands above the panel with its version hanging into a gap a
    // little wider than the 8px between the boxes, and the three stand in the
    // middle of the page, to within the line's spare room above the word
    assert.equal(home.brandName, "Facilitator");
    const gap = home.panel.top - home.versionBottom;
    assert.ok(gap > 8 && gap < 16, "the heading is " + gap + "px above the panel");
    const stackBottom = home.limitsBottom ?? home.panel.bottom;
    assert.ok(Math.abs((home.brand.top - home.page.top) - (home.page.bottom - stackBottom)) <= 5,
              JSON.stringify({ page: home.page, brand: home.brand, stackBottom }));
    // the chart is drawn to the view's height, 200 here, never stretched, and
    // scrolls sideways, opening on the latest weeks, clear of the menus' strips
    assert.equal(home.view.bottom - home.view.top, 200);
    assert.equal(home.chartWidth, home.expected.width);
    assert.ok(home.chartWidth > home.lane.right - home.lane.left, "the year is wider than the screen, so it scrolls");
    assert.ok(home.atLatest, "the heatmap opens on its latest weeks");
    // the box hugs the chart: the chart fills its view top to bottom, the
    // squares and month names fill the chart but for a few pixels, and the
    // panel ends a padding under the foot
    assert.ok(Math.abs(home.chart.top - home.view.top) < 0.5 && Math.abs(home.chart.bottom - home.view.bottom) < 0.5,
              JSON.stringify({ chart: home.chart, view: home.view }));
    assert.ok(home.rows.top - home.view.top < 30 && home.view.bottom - home.rows.bottom < 8, JSON.stringify(home.rows));
    assert.ok(home.expected.cell >= 18, "squares far larger than the 11px strip they were");
    assert.ok(home.view.top - home.head <= 15 && home.foot.top - home.view.bottom <= 11, "no band over or under the chart");
    assert.ok(home.panelBottom - home.foot.bottom <= 16, "the box ends under the foot");
    assert.ok(home.lane.left > 28 && home.lane.right < 375 - 28, JSON.stringify(home.lane));
    assert.equal(home.card, "hidden");
    assert.equal(home.hadHistory, true, "the card behind shows its history arrows on its board");
    assert.equal(home.cardParts, 0, "no part of the card shows through home, its arrows included");
    assert.equal(home.composers, 0, "no composer on home");
    assert.equal(home.lists, 0, "no card list of its own");

    // a tap on a day shows its tip, and a tap anywhere else takes it away
    const sq = await page.evaluate(() => {
      const s = [...document.querySelectorAll(".tk-day")].at(-1).getBoundingClientRect();
      return { x: s.left + s.width / 2, y: s.top + s.height / 2 };
    });
    await page.touchscreen.tap(sq.x, sq.y);
    await settle(150);
    assert.equal(await page.$eval(".tk-tip", t => t.hidden), false, "a tap shows the day's tip");
    const [y, m, d] = day(0).split("-").map(Number);
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
    assert.match(await page.$eval(".tk-tip", t => t.textContent),
                 new RegExp(`^1\\.1\\dK tokens that day\\w{3}, ${month} ${d}, ${y}$`), "today's square, today's count");
    await page.touchscreen.tap(187, 700);
    await settle(150);
    assert.equal(await page.$eval(".tk-tip", t => t.hidden), true, "a tap elsewhere hides it");
    // a mouse still hovers, as on the board
    await page.mouse.move(sq.x, sq.y);
    await settle(150);
    assert.equal(await page.$eval(".tk-tip", t => t.hidden), false, "a mouse over a day shows its tip");
    await page.mouse.move(187, 700);
    await settle(150);
    assert.equal(await page.$eval(".tk-tip", t => t.hidden), true);

    // the pill by tap
    await page.tap('.tk-opt[data-view="line"]');
    await page.waitForSelector("svg.tk-line", { timeout: 5000 });
    assert.deepEqual(await page.$$eval(".tk-opt", bs => bs.map(b => b.getAttribute("aria-pressed"))), ["false", "true"]);
    const pt = await page.evaluate(() => {
      const svg = document.querySelector("svg.tk-line"), b = svg.getBoundingClientRect();
      const p = document.querySelector(".tk-stage").tkModel.model.points.at(-1);
      return { x: b.left + p.x - 2, y: b.top + p.y };
    });
    await page.touchscreen.tap(pt.x, pt.y);
    await settle(150);
    assert.equal(await page.$eval(".tk-tip", t => t.hidden), false, "a tap on the line shows its tip");
    assert.equal(await page.$eval(".tk-dot", d => d.getAttribute("visibility")), "visible");
    // the line's foot names the tool the counts come from: the fixture's logs are Claude's alone
    assert.equal(await page.$eval(".tk-sum", s => s.textContent), "Includes data from Claude");
    assert.equal(await page.$eval(".tk-legend", l => l.textContent), "Daily7-day average", "the legend stays");

    // a project chosen in the list: that project's board, its row checked, the house not
    const owner = await page.$eval("#projlist .projrow:last-child", t => t.dataset.owner);
    await page.tap("#projbtn");
    await page.waitForFunction(() => document.body.classList.contains("projopen"), { timeout: 3000 });
    await settle(300);
    await page.tap(`#projlist .projrow[data-owner="${owner}"]`);
    await settle(300);
    const back = await page.evaluate(() => ({
      body: document.body.classList.contains("home"),
      pressed: document.getElementById("homeico").getAttribute("aria-pressed"),
      seated: document.querySelector("#projlist .projrow.on")?.dataset.owner,
      home: getComputedStyle(document.getElementById("home")).display,
      card: getComputedStyle(document.getElementById("cards")).visibility,
      stored: localStorage.getItem("homeopen") }));
    assert.deepEqual(back, { body: false, pressed: "false", seated: owner, home: "none", card: "visible", stored: null });
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
