// the limits box on the home page: what home-widgets.js draws from the route's
// answer (run in a small DOM, no browser), the rules the two pages carry for it
// as text, and where it stands in a real browser: on the board directly under
// the token panel, as wide as it, the pair centred in the frame's height and on
// the right half's vertical line, with the thin line down the frame's middle;
// on the phone directly under the panel. the numbers it keeps in the browser,
// its "Last updated" line and the way a bar moves to fresh numbers are held in
// the small DOM below. the route's answer is replaced in the browser, so one
// fixture board serves every combination of tools; the route itself is held in
// limits.test.cjs. every number is invented
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { launch } = require("./resp-harness.cjs");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const WIDGETS = read("home-widgets.js");
const SHEET = read("home-widgets.css");
const BOARD = read("index.html");
const PHONE = read("m.html");
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

// ---- a small DOM ---------------------------------------------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.className = "";
    this.style = {};
    this.attrs = {};
    this.hidden = false;
    this._text = "";
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
}
const makeRoot = () => { const doc = { createElement: tag => new El(tag, doc) }; return new El("div", doc); };
const walk = (el, out = []) => { for (const c of el.children) { out.push(c); walk(c, out); } return out; };
const widgets = () => {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(WIDGETS, ctx);
  return ctx.TokenWidgets;
};
const win = used => ({ used, resets: 4102444800 });
const BOTH = { claude: { five_hour: win(23), weekly: win(41) }, codex: { five_hour: win(7), weekly: win(88) } };

// every plain rule of a style sheet or a page's style blocks, comments stripped
function rulesOf(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")),
    decls: Object.fromEntries(m[2].split(";").map(d => d.trim()).filter(Boolean).map(d => {
      const at = d.indexOf(":");
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    })),
  }));
}
const styleBlocks = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const declsFor = (rules, selector) => {
  const out = {};
  for (const r of rules) if (r.selectors.includes(selector)) Object.assign(out, r.decls);
  return out;
};

// ---- what the widget draws ----------------------------------------------------------------
test("the rows are the tool and window, in a fixed order, each a whole percent, only where the answer has a number", () => {
  const W = widgets();
  const rows = answer => JSON.parse(JSON.stringify(W.limitRows(answer)));   // out of the sandbox's realm
  assert.deepEqual(rows(BOTH), [
    { label: "Claude 5-hour", used: 23 }, { label: "Claude weekly", used: 41 },
    { label: "Codex 5-hour", used: 7 }, { label: "Codex weekly", used: 88 },
  ]);
  assert.deepEqual(rows({ codex: { weekly: win(12.6) } }), [{ label: "Codex weekly", used: 13 }]);
  assert.deepEqual(rows({ claude: { five_hour: win(150), weekly: win(-4) } }),
                   [{ label: "Claude 5-hour", used: 100 }, { label: "Claude weekly", used: 0 }]);
  for (const nothing of [{}, null, undefined, [], "x", { claude: {} }, { claude: null, codex: { weekly: {} } },
                         { claude: { weekly: { used: "5" } } }, { codex: { weekly: { used: NaN } } }])
    assert.deepEqual(rows(nothing), [], JSON.stringify(nothing));
  // no row for a model's own limit, a credit or anything else the answer might carry
  assert.deepEqual(rows({ claude: { five_hour: win(1), sonnet: win(99), opus_weekly: win(98) }, credits: win(5) }),
                   [{ label: "Claude 5-hour", used: 1 }]);
});

test("a row is a name, a bar and a percent, and the box has nothing else in it", async () => {
  const W = widgets();
  const root = makeRoot();
  const box = W.limits(root, { load: async () => BOTH });
  assert.equal(root.hidden, true, "hidden until there is something to show");
  await box.refresh();
  assert.equal(root.hidden, false);
  assert.equal(root.children.length, 1);
  const panel = root.children[0];
  assert.equal(panel.className, "tk-panel lm-box", "the token panel's own box");
  assert.deepEqual(panel.children.map(r => r.className), ["lm-title", ...Array(4).fill("lm-row"), "lm-updated"],
                   "the title, four rows and the faint line under them");
  assert.equal(panel.children[0].textContent, "Usage Limits");
  const lines = panel.children.slice(1, 5);
  assert.deepEqual(lines.map(r => r.children.map(c => c.className)), Array(4).fill(["lm-name", "lm-bar", "lm-pct"]));
  assert.deepEqual(lines.map(r => r.children[0].textContent),
                   ["Claude 5-hour", "Claude weekly", "Codex 5-hour", "Codex weekly"]);
  assert.deepEqual(lines.map(r => r.children[2].textContent), ["23%", "41%", "7%", "88%"]);
  const bars = lines.map(r => r.children[1]);
  assert.deepEqual(bars.map(b => b.children[0].style.width), ["23%", "41%", "7%", "88%"]);
  assert.deepEqual(bars.map(b => b.attrs.role), Array(4).fill("progressbar"));
  assert.deepEqual(bars.map(b => b.attrs["aria-valuenow"]), ["23", "41", "7", "88"]);
  // the title and nothing else above the rows: no subtitle, legend, reset time,
  // status sentence or icon; an answer that does not say when it was taken
  // leaves the faint line empty
  assert.equal(root.textContent, "Usage LimitsClaude 5-hour23%Claude weekly41%Codex 5-hour7%Codex weekly88%");
  assert.equal(panel.children[5].textContent, "");
  assert.ok(!walk(root).some(n => ["SVG", "IMG", "H1", "H2", "H3", "BUTTON"].includes(n.tagName)));
  assert.ok(!walk(root).some(n => /tk-(head|name|what|foot|legend|note|sum)/.test(n.className)));
});

test("a tool with no number has no rows, and with neither the box is hidden and says nothing", async () => {
  const W = widgets();
  const root = makeRoot();
  let answer = { codex: { five_hour: win(7), weekly: win(88) } };
  const box = W.limits(root, { load: async () => answer });
  await box.refresh();
  assert.equal(root.textContent, "Usage LimitsCodex 5-hour7%Codex weekly88%");
  answer = { claude: { weekly: win(41) } };
  await box.refresh();
  assert.equal(root.textContent, "Usage LimitsClaude weekly41%");
  answer = {};
  await box.refresh();
  assert.equal(root.hidden, true);
  assert.equal(root.textContent, "", "no message in its place");
  assert.equal(root.children.length, 0);
});

test("a reading that cannot be had leaves the last drawing, and one request is out at a time", async () => {
  const W = widgets();
  const root = makeRoot();
  let fail = false, asked = 0, release;
  const box = W.limits(root, { load: () => {
    asked++;
    if (fail) return Promise.reject(new Error("down"));
    return new Promise(res => { release = () => res(BOTH); });
  } });
  const first = box.refresh();
  assert.equal(box.refresh(), first, "a second refresh while one is out is the same one");
  await settle();
  assert.equal(asked, 1);
  release();
  await first;
  assert.equal(root.children[0].children.length, 6, "the title, four rows and the faint line");
  fail = true;
  await box.refresh();
  assert.equal(root.children[0].children.length, 6, "the rows stay");
  assert.equal(root.hidden, false);
  assert.equal(asked, 2);
});

// ---- the numbers kept, the faint line and the bars' change -------------------------------------
const memory = () => {
  const kept = new Map();
  return { getItem: k => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } };
};
const T0 = 1_000_000_000_000;                 // a browser clock, in milliseconds
const taken = (extra = {}) => ({ ...BOTH, fetched: 1000, now: 1000, refreshing: false, ...extra });

test("the numbers last received are kept in the browser, and a fresh install shows nothing", async () => {
  const W = widgets();
  assert.equal(W.LIMITS_KEY, "home.limits");
  const store = memory();
  const root = makeRoot();
  const box = W.limits(root, { store, now: () => T0, load: async () => taken() });
  assert.equal(root.hidden, true, "nothing kept, nothing shown");
  assert.equal(store.getItem(W.LIMITS_KEY), null, "and nothing written before an answer");
  await box.refresh();
  const kept = JSON.parse(store.getItem(W.LIMITS_KEY));
  assert.deepEqual(Object.keys(kept).sort(), ["answer", "at"]);
  assert.equal(kept.at, T0, "the server's fetch, on this browser's clock");
  assert.deepEqual(Object.keys(kept.answer).sort(), ["claude", "codex"], "the numbers and nothing else");
  assert.deepEqual(kept.answer.codex.weekly, win(88));
  // a page opened later draws them before it asks for anything
  const later = makeRoot();
  let asked = 0;
  W.limits(later, { store, now: () => T0 + 90_000, load: () => { asked++; return new Promise(() => {}); } });
  assert.equal(later.hidden, false, "drawn as soon as the box is made");
  assert.equal(later.textContent, "Usage LimitsClaude 5-hour23%Claude weekly41%Codex 5-hour7%Codex weekly88%Last updated 1 min ago");
  assert.equal(asked, 0, "drawing from what was kept asks for nothing");
  // a store that cannot be read or written leaves the box as it would be without one
  for (const broken of [{ getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } },
                        { getItem: () => "{not json", setItem: () => {} }, { getItem: () => '{"answer":7}', setItem: () => {} }, null]) {
    const r = makeRoot();
    const b = W.limits(r, { store: broken, now: () => T0, load: async () => taken() });
    assert.equal(r.hidden, true);
    await b.refresh();
    assert.equal(r.hidden, false);
  }
});

test("a window that ended while the numbers were kept is drawn as 0", () => {
  const W = widgets();
  const store = memory();
  store.setItem(W.LIMITS_KEY, JSON.stringify({ at: T0, answer: { codex: { five_hour: { used: 55, resets: T0 / 1000 + 60 }, weekly: win(61) } } }));
  const root = makeRoot();
  W.limits(root, { store, now: () => T0 + 120_000, load: () => new Promise(() => {}) });
  assert.equal(root.textContent, "Usage LimitsCodex 5-hour0%Codex weekly61%Last updated 2 min ago");
});

test("the faint line counts from the server's fetch, on the server's clock, and ticks while the box is open", async () => {
  const W = widgets();
  for (const [seconds, words] of [[0, "just now"], [59, "just now"], [60, "1 min ago"], [3599, "59 min ago"],
                                  [3600, "1 h ago"], [86399, "23 h ago"], [86400, "1 d ago"], [3 * 86400 + 5, "3 d ago"]])
    assert.equal(W.ago(seconds), words, `${seconds} seconds`);
  assert.equal(W.ago(-5), "just now");
  assert.equal(W.ago(NaN), "just now");
  let t = T0;
  const root = makeRoot();
  let asked = 0;
  // the server's clock is a day ahead of the browser's: only the difference counts
  const box = W.limits(root, { store: null, now: () => t, load: async () => { asked++; return taken({ fetched: 5000, now: 5090 }); } });
  const note = () => root.children[0].children[5];
  await box.refresh();
  assert.equal(note().className, "lm-updated");
  assert.equal(note().textContent, "Last updated 1 min ago", "90 seconds before the answer");
  t += 30_000;
  box.tick();
  assert.equal(note().textContent, "Last updated 2 min ago");
  t += 3 * 3600_000;
  box.tick();
  assert.equal(note().textContent, "Last updated 3 h ago");
  assert.equal(asked, 1, "ticking asks for nothing");
  // a fresh fetch time starts the count again
  await box.refresh();
  assert.equal(note().textContent, "Last updated 1 min ago");
  // an answer that does not say when it was taken has no line
  const bare = makeRoot();
  const other = W.limits(bare, { store: null, now: () => t, load: async () => BOTH });
  await other.refresh();
  assert.equal(bare.children[0].children[5].textContent, "");
});

test("fresh numbers move the bars and the percents in place: the same rows, nothing rebuilt", async () => {
  const W = widgets();
  const root = makeRoot();
  let answer = taken();
  const box = W.limits(root, { store: null, now: () => T0, load: async () => answer });
  await box.refresh();
  const panel = root.children[0];
  const title = panel.children[0];
  const parts = panel.children.slice(1, 5).map(r => ({ row: r, bar: r.children[1], fill: r.children[1].children[0], pct: r.children[2] }));
  answer = taken({ claude: { five_hour: win(30), weekly: win(41) }, codex: { five_hour: win(2), weekly: win(90) } });
  await box.refresh();
  assert.equal(root.children[0], panel, "the same box");
  assert.equal(panel.children[0], title, "the same title");
  assert.equal(panel.children.length, 6);
  panel.children.slice(1, 5).forEach((r, i) => {
    assert.equal(r, parts[i].row, `row ${i} kept`);
    assert.equal(r.children[1], parts[i].bar);
    assert.equal(r.children[1].children[0], parts[i].fill, `fill ${i} kept, so its width can move smoothly`);
    assert.equal(r.children[2], parts[i].pct);
  });
  assert.deepEqual(parts.map(p => p.fill.style.width), ["30%", "41%", "2%", "90%"]);
  assert.deepEqual(parts.map(p => p.pct.textContent), ["30%", "41%", "2%", "90%"]);
  assert.deepEqual(parts.map(p => p.bar.attrs["aria-valuenow"]), ["30", "41", "2", "90"]);
  // a tool gone or arriving changes the rows, and then the box is drawn again
  answer = taken({ codex: undefined });
  await box.refresh();
  assert.equal(root.children[0].children.length, 4, "the title, two rows and the faint line");
});

test("while the server renews its reading the box asks again a few times, and stops when it is done", async () => {
  const W = widgets();
  const root = makeRoot();
  const queue = [];
  let asked = 0, refreshing = true;
  const box = W.limits(root, { store: null, later: (fn, ms) => queue.push({ fn, ms }),
    load: async () => { asked++; return taken({ refreshing }); } });
  await box.refresh();
  assert.equal(asked, 1);
  assert.equal(queue.length, 1, "one more ask is waiting");
  assert.equal(queue[0].ms, 2000);
  for (let k = 0; k < 20 && queue.length; k++) { queue.shift().fn(); await settle(); }
  assert.equal(asked, 9, "one ask and eight follow-ups, never more");
  // done as soon as the server says so
  asked = 0; refreshing = true;
  await box.refresh();
  refreshing = false;
  queue.shift().fn();
  await settle();
  assert.equal(asked, 2);
  assert.equal(queue.length, 0, "no ask waiting");
  // a new press starts its own chain and the older one lapses
  asked = 0; refreshing = true;
  await box.refresh();
  await box.refresh();
  assert.equal(queue.length, 2);
  queue.shift().fn();
  await settle();
  assert.equal(asked, 2, "the older chain's ask did not go out");
});

test("the box asks for /limits and nothing else, and only the limits box does", () => {
  const body = WIDGETS.slice(WIDGETS.indexOf("function limits(root"));
  assert.deepEqual([...body.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]), ['"/limits"']);
  assert.deepEqual([...WIDGETS.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]),
                   ['"/tokens/daily?days=" + FETCH_DAYS', '"/limits"'], "the panel's days and the box's limits, nothing else");
});

// ---- the rules the pages carry ---------------------------------------------------------------
test("the bars wear the token chart's colours: the line's colour for the fill, the heatmap's lightest tint for the track", async () => {
  const W = widgets();
  assert.equal(W.LIMIT_FILL, W.LINE, "the daily line's colour");
  assert.equal(W.LIMIT_TRACK, W.PALETTE[1], "the heatmap's lightest tint");
  assert.equal(W.LIMIT_FILL, "#E0592B");
  assert.equal(W.LIMIT_TRACK, "#FCD8C2");
  const root = makeRoot();
  await W.limits(root, { store: null, load: async () => BOTH }).refresh();
  const bars = walk(root).filter(n => n.className === "lm-bar");
  assert.equal(bars.length, 4);
  for (const bar of bars) {
    assert.equal(bar.style.background, W.LIMIT_TRACK);
    assert.equal(bar.children[0].style.background, W.LIMIT_FILL);
  }
  // the sheet writes no colour of its own into the box: the bars' two colours come from the chart's
  const rules = rulesOf(SHEET).filter(r => r.selectors.some(s => s.startsWith(".lm-")));
  assert.ok(rules.length >= 6);
  for (const r of rules) for (const [k, v] of Object.entries(r.decls))
    assert.doesNotMatch(v, /--accent|rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b/i, `${r.selectors.join(", ")} sets ${k}: ${v}`);
  const bar = declsFor(rules, ".lm-bar"), fill = declsFor(rules, ".lm-fill");
  assert.equal(fill.background, undefined);
  assert.equal(bar.background, undefined);
  assert.equal(bar.border, "var(--edge) solid var(--line)", "the board's own edge round the track");
  assert.equal(rules.find(r => r.selectors.includes(".lm-fill")).decls.transition, "width .7s var(--gentle)",
               "a bar moves to its new width smoothly");
  assert.equal(declsFor(rules, ".lm-pct")["min-width"], "4ch", "the track does not move when the digits change");
  assert.match(SHEET, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.lm-fill\{transition:none\}/);
  // the pages' own rules for the box carry no colour either, and no violet or accent anywhere near it
  const mine = rulesOf(styleBlocks(BOARD)).filter(r => r.selectors.some(s => /homelimits|homepair|homeline/.test(s)))
    .concat(rulesOf(styleBlocks(PHONE)).filter(r => r.selectors.some(s => /homelimits/.test(s))));
  assert.ok(mine.length >= 5);
  for (const r of mine) for (const [k, v] of Object.entries(r.decls))
    assert.doesNotMatch(v, /--accent|#[0-9a-f]{3,8}\b|rgba?\(/i, `${r.selectors.join(", ")} sets ${k}: ${v}`);
  assert.doesNotMatch(SHEET.slice(SHEET.indexOf(".lm-box")), /432BFF|EEEBFF|accent/i);
  assert.doesNotMatch(WIDGETS.slice(WIDGETS.indexOf("const LIMIT_ROWS")), /#432BFF|#EEEBFF|--accent/i);
});

test("the faint line is small and faint, in the board's own footnote style, bottom left across the box", () => {
  const rules = rulesOf(SHEET);
  const note = declsFor(rules, ".lm-updated"), foot = declsFor(rules, ".tk-foot");
  assert.equal(note.color, foot.color, "the foot's own faint colour");
  assert.equal(note.color, "var(--sub)");
  assert.equal(note["grid-column"], "1 / -1");
  assert.equal(note["justify-self"], "start", "at the left");
  assert.match(note.font, /^400 11px\/14px var\(--sans\)$/, "a step under the panel's 12px");
  assert.match(declsFor(rules, ".tk-panel").font, /^400 12px\/16px var\(--sans\)$/);
  assert.equal(declsFor(rules, ".lm-updated:empty").display, "none", "no line, no space, until there is a time");
});

test("the title is set like the token panel's heading and takes the grid's whole width", () => {
  const rules = rulesOf(SHEET);
  const title = declsFor(rules, ".lm-title"), name = declsFor(rules, ".tk-name");
  assert.equal(title.font, name.font, "the heading's own face, size and weight");
  assert.match(title.font, /^600 14px\/18px var\(--sans\)$/);
  assert.equal(title.color, name.color);
  assert.equal(title["grid-column"], "1 / -1");
  assert.match(WIDGETS, /el\("span", "lm-title", "Usage Limits"\)/);
  assert.doesNotMatch(PHONE, /\.lm-title/, "the phone takes the shared rule as it is");
});

test("the board's rules make the token box and the limits box one column, centred, with a named gap", () => {
  const rules = rulesOf(styleBlocks(BOARD));
  assert.equal(declsFor(rules, "#homepair").display, "none", "only on home");
  const pair = declsFor(rules, "body.focus.home #homepair");
  assert.equal(pair.display, "flex");
  assert.equal(pair["flex-direction"], "column");
  assert.equal(pair["justify-content"], "center", "the pair is centred in the frame's height");
  assert.equal(pair.position, "fixed");
  assert.equal(pair["pointer-events"], "none");
  assert.equal(pair["--home-gap"], "calc(var(--sp-m) * 1.5)", "one and a half of the board's medium gap");
  assert.equal(pair.gap, "var(--home-gap)");
  assert.equal(pair["--home-w"], "calc((var(--home-r) - var(--home-l)) * .35)", "the token panel's own width");
  assert.equal(pair.width, "var(--home-w)");
  assert.equal(pair.left, "calc(var(--home-l) * .25 + var(--home-r) * .75 - var(--home-w) / 2)",
               "centred on the right half's vertical line, following the window");
  assert.equal(pair.top, "var(--home-t)");
  assert.equal(pair.height, "calc(var(--home-b) - var(--home-t))", "as tall as the frame");
  const token = declsFor(rules, "body.focus.home #home");
  assert.equal(token.flex, "0 1 calc((var(--home-b) - var(--home-t)) * .35)", "its own 35%, giving up height only to fit");
  assert.equal(token["min-height"], "0");
  const mine = declsFor(rules, "body.focus.home #homelimits:not([hidden])");
  assert.equal(declsFor(rules, "#homelimits").display, "none");
  assert.equal(mine.display, "block");
  assert.equal(mine.flex, "none", "as tall as its rows");
  for (const k of ["position", "left", "top", "width", "transform", "height"]) assert.equal(mine[k], undefined, `no ${k} of its own`);
  assert.match(BOARD, /<div id="homepair">\s*<section id="home" aria-label="Home"><div id="homeplot"><\/div><\/section>[\s\S]*?<section id="homelimits" aria-label="Plan limits" hidden><\/section>\s*<\/div>/);
  assert.match(BOARD, /--sp-m:calc\(/, "the gap's name is built on the board's own medium spacing");
});

test("the board's rule draws a thin line down the middle of the frame, 70% of its height, in the board's line colour", () => {
  const rules = rulesOf(styleBlocks(BOARD));
  assert.equal(declsFor(rules, "#homeline").display, "none", "only on home");
  const line = declsFor(rules, "body.focus.home #homeline");
  assert.equal(line.position, "fixed");
  assert.equal(line["pointer-events"], "none", "not interactive");
  assert.equal(line.left, "calc((var(--home-l) + var(--home-r)) / 2)", "the frame's horizontal centre");
  assert.equal(line.top, "calc(var(--home-t) * .85 + var(--home-b) * .15)", "15% of the frame down");
  assert.equal(line.height, "calc((var(--home-b) - var(--home-t)) * .7)", "70% of the frame's height");
  assert.equal(line.width, "var(--edge-drawn)", "the board's hairline");
  assert.equal(line.transform, "translateX(-50%)");
  assert.equal(line.background, "var(--line)", "the colour under Doing, Deferred and Done");
  for (const v of Object.values(line)) assert.doesNotMatch(v, /--accent/);
  assert.equal(BOARD.match(/<div id="homeline" aria-hidden="true"><\/div>/g).length, 1);
  assert.doesNotMatch(PHONE, /homeline/, "the phone has no centre line");
});

test("the phone's rule puts it directly under the token panel", () => {
  assert.match(PHONE, /<section id="home" aria-label="Home"><div id="homeplot"><\/div><div id="homelimits" hidden><\/div><\/section>/);
  const rules = rulesOf(styleBlocks(PHONE));
  assert.equal(declsFor(rules, "#home #homelimits")["margin-top"], "8px");
  assert.equal(declsFor(rules, "#home .tk-panel")["padding-left"], "22px", "the same sides as the token panel's");
});

// ---- where it stands in a browser ------------------------------------------------------------
let fx;
before(async () => {
  fx = await launch({ files: ["home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"], onlyBin: true });
});
after(async () => { if (fx) await fx.stop(); });

const MAC = [{ width: 1512, height: 982 }, { width: 1280, height: 800 }];
const PHONE_VIEW = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const CASES = {
  both: BOTH,
  "only Codex": { codex: BOTH.codex },
  "only Claude": { claude: BOTH.claude },
  neither: {},
};

async function openHome(page, answer, url = "/") {
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/limits")
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(answer) });
    else request.continue();
  });
  if (url !== "/") {
    await page.goto(fx.origin + url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
  }
  await page.click("#homeico", { delay: 10 }).catch(() => page.tap("#homeico"));
  await page.waitForSelector("svg.tk-heat", { timeout: 15000 });
  await new Promise(r => setTimeout(r, 400));
}
const measure = page => page.evaluate(() => {
  const R = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const box = document.getElementById("homelimits");
  return {
    shown: !box.hidden && getComputedStyle(box).display !== "none",
    token: R(document.querySelector("#home .tk-panel")),
    limits: box.hidden ? null : R(box.querySelector(".tk-panel")),
    holder: R(box),
    frame: document.getElementById("appframe") ? R(document.getElementById("appframe")) : null,
    line: document.getElementById("homeline") ? R(document.getElementById("homeline")) : null,
    gap: parseFloat(getComputedStyle(document.getElementById("homepair") || document.body).rowGap) || 0,
    rows: [...box.querySelectorAll(".lm-row")].map(row => ({
      name: row.querySelector(".lm-name").textContent, pct: row.querySelector(".lm-pct").textContent,
      fill: row.querySelector(".lm-fill").style.width })),
    text: box.textContent,
  };
});
// the pair, the line and the frame, each against the other, within a pixel
function checkBoard(m, where, withLimits) {
  const near = (a, b, label, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${where}: ${label}: ${a} vs ${b}`);
  const frameH = m.frame.bottom - m.frame.top, frameW = m.frame.right - m.frame.left;
  const midX = (m.frame.left + m.frame.right) / 2, midY = (m.frame.top + m.frame.bottom) / 2;
  near((m.line.left + m.line.right) / 2, midX, "the line at the frame's horizontal centre");
  near(m.line.height, 0.7 * frameH, "the line 70% of the frame's height");
  near(m.line.top - m.frame.top, m.frame.bottom - m.line.bottom, "the line's gap to the top and to the bottom");
  assert.ok(m.line.top - m.frame.top > 10 && m.frame.bottom - m.line.bottom > 10, `${where}: the line touches neither edge`);
  assert.ok(m.line.width <= 2 && m.line.width > 0, `${where}: a thin line, ${m.line.width}`);
  const top = m.token.top, bottom = withLimits ? m.limits.bottom : m.token.bottom;
  near((top + bottom) / 2, midY, "the pair's centre against the frame's");
  const rightCx = m.frame.left + 0.75 * frameW;
  near((m.token.left + m.token.right) / 2, rightCx, "the token panel on the right half's line");
  near(m.token.width, 0.35 * frameW, "the token panel's width");
  near(m.token.height, 0.35 * frameH, "the token panel keeps its 35%");
  assert.ok(m.token.left > midX && m.token.top >= m.frame.top && bottom <= m.frame.bottom, `${where}: inside the right half`);
  if (!withLimits) return;
  near((m.limits.left + m.limits.right) / 2, (m.token.left + m.token.right) / 2, "the limits box on the same line");
  near(m.limits.width, m.token.width, "as wide as the token panel");
  near(m.limits.top - m.token.bottom, m.gap, "the gap between them is the named gap");
  assert.ok(m.gap > 8 && m.gap < 40, `${where}: the board's medium gap, ${m.gap}`);
}

test("on the board the limits box sits under the token panel as one unit, centred in the frame, with the thin line down the middle", async () => {
  for (const view of MAC) for (const [name, answer] of Object.entries(CASES)) {
    const { context, page } = await fx.openBoard(null, view);
    try {
      await openHome(page, answer);
      const m = await measure(page);
      const where = `${view.width}x${view.height}, ${name}`;
      const rows = Object.values(answer).reduce((n, tool) => n + Object.keys(tool).length, 0);
      assert.equal(m.shown, rows > 0, `${where}: shown only with a row`);
      assert.equal(m.rows.length, rows, where);
      if (!rows) assert.equal(m.text, "", `${where}: nothing in its place`);
      checkBoard(m, where, rows > 0);
      if (rows) assert.ok(m.limits.height < 0.4 * (m.frame.bottom - m.frame.top), `${where}: only as tall as its rows`);
    } finally { await context.close(); }
  }
});

test("on the board the gap between the two boxes is one and a half of the board's medium gap", async () => {
  for (const view of MAC) {
    const { context, page } = await fx.openBoard(null, view);
    try {
      await openHome(page, BOTH);
      const m = await measure(page);
      const medium = await page.evaluate(() => {
        const probe = document.createElement("i");
        probe.style.cssText = "position:absolute; visibility:hidden; width:1px; height:var(--sp-m)";
        document.body.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return h;
      });
      const gap = m.limits.top - m.token.bottom;
      assert.ok(medium > 8, `${view.width}x${view.height}: a medium gap of ${medium}`);
      assert.ok(Math.abs(gap - 1.5 * medium) <= 0.5, `${view.width}x${view.height}: ${gap} against ${1.5 * medium}`);
    } finally { await context.close(); }
  }
});

test("the title reads Usage Limits in the token heading's face, on the board and on the phone, and the rows stay in their columns", async () => {
  const read = () => {
    const token = document.querySelector("#home .tk-name"), title = document.querySelector("#homelimits .lm-title");
    const face = n => { const s = getComputedStyle(n); return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.color].join("|"); };
    const inkTop = n => { const r = document.createRange(); r.selectNodeContents(n); return r.getClientRects()[0].top - n.closest(".tk-panel").getBoundingClientRect().top; };
    const lefts = [...document.querySelectorAll("#homelimits .lm-name")].map(n => Math.round(n.getBoundingClientRect().left));
    const bars = [...document.querySelectorAll("#homelimits .lm-bar")].map(n => Math.round(n.getBoundingClientRect().left));
    const t = title.getBoundingClientRect(), first = document.querySelector("#homelimits .lm-name").getBoundingClientRect();
    return { text: title.textContent, tokenFace: face(token), titleFace: face(title), weight: getComputedStyle(title).fontWeight,
             inkOffset: inkTop(title) - inkTop(token), lefts, bars, above: t.bottom <= first.top, titleLeft: t.left };
  };
  for (const view of MAC) {
    const { context, page } = await fx.openBoard(null, view);
    try {
      await openHome(page, BOTH);
      const r = await page.evaluate(read);
      const where = `${view.width}x${view.height}`;
      assert.equal(r.text, "Usage Limits", where);
      assert.equal(r.titleFace, r.tokenFace, `${where}: the token heading's face, size, weight and colour`);
      assert.ok(Number(r.weight) >= 600, `${where}: bold`);
      assert.ok(Math.abs(r.inkOffset) <= 1, `${where}: stands where the token heading stands, ${r.inkOffset}`);
      assert.ok(r.above, `${where}: above the first row`);
      assert.equal(new Set(r.lefts).size, 1, `${where}: the names share a column`);
      assert.equal(new Set(r.bars).size, 1, `${where}: the bars share a column`);
      assert.ok(Math.abs(r.titleLeft - r.lefts[0]) <= 1, `${where}: the title starts where the names do`);
    } finally { await context.close(); }
  }
  const { context, page } = await fx.openBoard(null, MAC[0]);
  try {
    await page.setViewport(PHONE_VIEW);
    await page.goto(fx.origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
    await page.waitForSelector("#tabbar .ptab.on", { timeout: 5000 });
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/limits")
        request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(BOTH) });
      else request.continue();
    });
    await page.tap("#homeico");
    await page.waitForSelector("svg.tk-heat", { timeout: 15000 });
    await new Promise(r => setTimeout(r, 400));
    const r = await page.evaluate(read);
    assert.equal(r.text, "Usage Limits", "phone");
    assert.equal(r.titleFace, r.tokenFace, "phone: the token heading's face, size, weight and colour");
    assert.ok(Number(r.weight) >= 600, "phone: bold");
    assert.ok(r.above, "phone: above the first row");
    assert.equal(new Set(r.lefts).size, 1, "phone: the names share a column");
    assert.equal(new Set(r.bars).size, 1, "phone: the bars share a column");
    assert.ok(Math.abs(r.titleLeft - r.lefts[0]) <= 1, "phone: the title starts where the names do");
  } finally { await context.close(); }
});

test("on the board the pair and the line follow a resize of the window", async () => {
  const { context, page } = await fx.openBoard(null, MAC[0]);
  try {
    await openHome(page, BOTH);
    for (const view of [MAC[1], { width: 1100, height: 700 }, { width: 1920, height: 1080 }, MAC[0]]) {
      await page.setViewport(view);
      await new Promise(r => setTimeout(r, 300));
      checkBoard(await measure(page), `${view.width}x${view.height}`, true);
    }
  } finally { await context.close(); }
});

test("the line takes no clicks, and the line and the pair are there only on home", async () => {
  const { context, page } = await fx.openBoard(null, MAC[0]);
  try {
    await openHome(page, BOTH);
    const on = await page.evaluate(() => {
      const line = document.getElementById("homeline"), s = getComputedStyle(line);
      const probe = document.createElement("i");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--line");
      document.body.appendChild(probe);
      const lineColour = getComputedStyle(probe).color;
      probe.remove();
      const r = line.getBoundingClientRect();
      return { display: s.display, events: s.pointerEvents, colour: s.backgroundColor, lineColour, hidden: line.getAttribute("aria-hidden"),
               hit: document.elementFromPoint(r.left + r.width / 2, (r.top + r.bottom) / 2)?.id || null };
    });
    assert.equal(on.display, "block");
    assert.equal(on.events, "none");
    assert.equal(on.colour, on.lineColour, "the board's own line colour");
    assert.equal(on.hidden, "true");
    assert.notEqual(on.hit, "homeline", "a click through the line reaches what is under it");
    await page.click("#tabbar .ptab:not(.ptabplus)", { delay: 10 });
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    const off = await page.evaluate(() => ["homeline", "homepair"].map(id => getComputedStyle(document.getElementById(id)).display));
    assert.deepEqual(off, ["none", "none"]);
  } finally { await context.close(); }
});

test("on the board the bars are the chart's colours in the browser's own paint", async () => {
  const { context, page } = await fx.openBoard(null, MAC[0]);
  try {
    await openHome(page, BOTH);
    const painted = await page.evaluate(() => {
      const bar = document.querySelector("#homelimits .lm-bar"), fill = bar.querySelector(".lm-fill");
      return { track: getComputedStyle(bar).backgroundColor, fill: getComputedStyle(fill).backgroundColor,
               edge: getComputedStyle(bar).borderTopColor, line: getComputedStyle(document.getElementById("homeline")).backgroundColor };
    });
    assert.equal(painted.fill, "rgb(224, 89, 43)", "the daily line's colour");
    assert.equal(painted.track, "rgb(252, 216, 194)", "the heatmap's lightest tint");
    assert.equal(painted.edge, painted.line, "the board's line colour round the track");
  } finally { await context.close(); }
});

test("on the phone the box stands directly under the token panel, as wide as it, and nothing above it moves", async () => {
  for (const [name, answer] of Object.entries(CASES)) {
    const { context, page } = await fx.openBoard(null, MAC[0]);
    try {
      await page.setViewport(PHONE_VIEW);
      await page.goto(fx.origin + "/m", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
      await page.waitForSelector("#tabbar .ptab.on", { timeout: 5000 });
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/limits")
          request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(answer) });
        else request.continue();
      });
      await page.tap("#homeico");
      await page.waitForSelector("svg.tk-heat", { timeout: 15000 });
      await new Promise(r => setTimeout(r, 400));
      const m = await measure(page);
      const rows = Object.values(answer).reduce((n, tool) => n + Object.keys(tool).length, 0);
      assert.equal(m.shown, rows > 0, name);
      assert.equal(m.rows.length, rows, name);
      if (!rows) { assert.equal(m.text, "", `${name}: nothing in its place`); continue; }
      assert.ok(Math.abs(m.limits.left - m.token.left) <= 0.6 && Math.abs(m.limits.right - m.token.right) <= 0.6,
                `${name}: as wide as the panel, ${JSON.stringify([m.limits, m.token])}`);
      assert.ok(m.limits.top >= m.token.bottom && m.limits.top - m.token.bottom <= 12, `${name}: directly under it`);
      assert.ok(m.limits.bottom <= 812, `${name}: on the screen`);
      assert.ok(m.limits.left >= 0 && m.limits.right <= 375, name);
      assert.equal(m.line, null, `${name}: the phone has no centre line`);
      const painted = await page.evaluate(() => {
        const bar = document.querySelector("#homelimits .lm-bar");
        return { track: getComputedStyle(bar).backgroundColor, fill: getComputedStyle(bar.querySelector(".lm-fill")).backgroundColor };
      });
      assert.deepEqual(painted, { track: "rgb(252, 216, 194)", fill: "rgb(224, 89, 43)" }, `${name}: the chart's colours on the phone too`);
    } finally { await context.close(); }
  }
});
