// the limits box on the home page: what home-widgets.js draws from the route's
// answer (run in a small DOM, no browser), the rules the two pages carry for it
// as text, and where it stands in a real browser: on the board in the bottom
// right quarter of the frame, centred under the token panel, a tenth of the
// frame's height up from its bottom and as wide as the panel; on the phone
// directly under the panel. the route's answer is replaced in the browser, so
// one fixture board serves every combination of tools; the route itself is held
// in limits.test.cjs. every number is invented
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
  assert.deepEqual(panel.children.map(r => r.className), Array(4).fill("lm-row"));
  assert.deepEqual(panel.children.map(r => r.children.map(c => c.className)), Array(4).fill(["lm-name", "lm-bar", "lm-pct"]));
  assert.deepEqual(panel.children.map(r => r.children[0].textContent),
                   ["Claude 5-hour", "Claude weekly", "Codex 5-hour", "Codex weekly"]);
  assert.deepEqual(panel.children.map(r => r.children[2].textContent), ["23%", "41%", "7%", "88%"]);
  const bars = panel.children.map(r => r.children[1]);
  assert.deepEqual(bars.map(b => b.children[0].style.width), ["23%", "41%", "7%", "88%"]);
  assert.deepEqual(bars.map(b => b.attrs.role), Array(4).fill("progressbar"));
  assert.deepEqual(bars.map(b => b.attrs["aria-valuenow"]), ["23", "41", "7", "88"]);
  // no heading, subtitle, legend, reset time, status sentence or icon
  assert.equal(root.textContent, "Claude 5-hour23%Claude weekly41%Codex 5-hour7%Codex weekly88%");
  assert.ok(!walk(root).some(n => ["SVG", "IMG", "H1", "H2", "H3", "BUTTON"].includes(n.tagName)));
  assert.ok(!walk(root).some(n => /tk-(head|name|what|foot|legend|note|sum)/.test(n.className)));
});

test("a tool with no number has no rows, and with neither the box is hidden and says nothing", async () => {
  const W = widgets();
  const root = makeRoot();
  let answer = { codex: { five_hour: win(7), weekly: win(88) } };
  const box = W.limits(root, { load: async () => answer });
  await box.refresh();
  assert.equal(root.textContent, "Codex 5-hour7%Codex weekly88%");
  answer = { claude: { weekly: win(41) } };
  await box.refresh();
  assert.equal(root.textContent, "Claude weekly41%");
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
  assert.equal(root.children[0].children.length, 4);
  fail = true;
  await box.refresh();
  assert.equal(root.children[0].children.length, 4, "the rows stay");
  assert.equal(root.hidden, false);
  assert.equal(asked, 2);
});

test("the box asks for /limits and nothing else, and only the limits box does", () => {
  const body = WIDGETS.slice(WIDGETS.indexOf("function limits(root"));
  assert.deepEqual([...body.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]), ['"/limits"']);
  assert.deepEqual([...WIDGETS.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]),
                   ['"/tokens/daily?days=" + FETCH_DAYS', '"/limits"'], "the panel's days and the box's limits, nothing else");
});

// ---- the rules the pages carry ---------------------------------------------------------------
test("the limits box wears no colour of its own and no violet", () => {
  const rules = rulesOf(SHEET).filter(r => r.selectors.some(s => s.startsWith(".lm-")));
  assert.ok(rules.length >= 6);
  for (const r of rules) for (const [k, v] of Object.entries(r.decls)) {
    const where = `${r.selectors.join(", ")} sets ${k}: ${v}`;
    if (v === "color-mix(in srgb, var(--paper) 92%, #fff 8%)") continue;   // the pill's track, as it is
    assert.doesNotMatch(v, /--accent|rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b/i, where);
  }
  const bar = declsFor(rules, ".lm-bar"), fill = declsFor(rules, ".lm-fill");
  assert.equal(fill.background, "var(--ink)");
  assert.equal(bar.background, "color-mix(in srgb, var(--paper) 92%, #fff 8%)", "the pill's own track");
  assert.equal(bar.border, "var(--edge) solid var(--line)");
  const mine = rulesOf(styleBlocks(BOARD)).filter(r => r.selectors.some(s => /homelimits/.test(s)))
    .concat(rulesOf(styleBlocks(PHONE)).filter(r => r.selectors.some(s => /homelimits/.test(s))));
  assert.ok(mine.length >= 3);
  for (const r of mine) for (const [k, v] of Object.entries(r.decls))
    assert.doesNotMatch(v, /--accent|#[0-9a-f]{3,8}\b|rgba?\(/i, `${r.selectors.join(", ")} sets ${k}: ${v}`);
  assert.doesNotMatch(SHEET.slice(SHEET.indexOf(".lm-box")), /432BFF|EEEBFF|accent/i);
});

test("the board's rule puts the box in the bottom right quarter, under the token box's own line", () => {
  const rules = rulesOf(styleBlocks(BOARD));
  const token = declsFor(rules, "body.focus.home #home");
  const mine = declsFor(rules, "body.focus.home #homelimits:not([hidden])");
  assert.equal(declsFor(rules, "#homelimits").display, "none");
  assert.equal(mine.position, "fixed");
  for (const v of ["--home-l", "--home-r", "--home-t", "--home-b"]) assert.equal(mine[v], token[v], v);
  assert.equal(mine.left, token.left, "the token box's own vertical line");
  assert.equal(mine.width, token.width, "its width");
  assert.equal(mine.top, "calc(var(--home-t) * .1 + var(--home-b) * .9)", "its bottom edge a tenth of the frame up");
  assert.equal(mine.transform, "translate(-50%, -100%)");
  assert.equal(mine.height, undefined, "as tall as its rows");
  assert.match(BOARD, /<section id="homelimits" aria-label="Plan limits" hidden><\/section>/);
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
    rows: [...box.querySelectorAll(".lm-row")].map(row => ({
      name: row.querySelector(".lm-name").textContent, pct: row.querySelector(".lm-pct").textContent,
      fill: row.querySelector(".lm-fill").style.width })),
    text: box.textContent,
  };
});

test("on the board the box is centred under the token panel, in the bottom right quarter, a tenth up from the frame's bottom", async () => {
  for (const view of MAC) for (const [name, answer] of Object.entries(CASES)) {
    const { context, page } = await fx.openBoard(null, view);
    try {
      await openHome(page, answer);
      const m = await measure(page);
      const where = `${view.width}x${view.height}, ${name}`;
      const rows = Object.values(answer).reduce((n, tool) => n + Object.keys(tool).length, 0);
      assert.equal(m.shown, rows > 0, `${where}: shown only with a row`);
      assert.equal(m.rows.length, rows, where);
      if (!rows) { assert.equal(m.text, "", `${where}: nothing in its place`); continue; }
      const near = (a, b, label, tol = 0.6) => assert.ok(Math.abs(a - b) <= tol, `${where}: ${label}: ${a} vs ${b}`);
      const c = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
      near(c(m.limits).x, c(m.token).x, "centre on the token panel's vertical line");
      near(m.limits.width, m.token.width, "as wide as the token panel");
      const midX = (m.frame.left + m.frame.right) / 2, midY = (m.frame.top + m.frame.bottom) / 2;
      assert.ok(m.limits.left >= midX && m.limits.right <= m.frame.right, `${where}: in the right half`);
      assert.ok(m.limits.top >= midY && m.limits.bottom <= m.frame.bottom, `${where}: in the bottom half`);
      near(m.frame.bottom - m.limits.bottom, 0.1 * (m.frame.bottom - m.frame.top), "bottom edge a tenth of the frame's height up", 1);
      assert.ok(m.limits.top >= m.token.bottom, `${where}: clear of the token panel`);
      // the token panel is where it was without the box: the frame's top right quarter
      near(c(m.token).y, m.frame.top + 0.25 * (m.frame.bottom - m.frame.top), "the token panel's centre", 1);
      assert.ok(m.limits.height < 0.4 * (m.frame.bottom - m.frame.top), `${where}: only as tall as its rows`);
    } finally { await context.close(); }
  }
});

test("on the board the box follows a resize of the window", async () => {
  const { context, page } = await fx.openBoard(null, MAC[0]);
  try {
    await openHome(page, BOTH);
    for (const view of [MAC[1], { width: 1700, height: 1000 }, MAC[0]]) {
      await page.setViewport(view);
      await new Promise(r => setTimeout(r, 300));
      const m = await measure(page);
      const where = `${view.width}x${view.height}`;
      const frameH = m.frame.bottom - m.frame.top;
      assert.ok(Math.abs(m.frame.bottom - m.limits.bottom - 0.1 * frameH) <= 1, where);
      assert.ok(Math.abs((m.limits.left + m.limits.right) / 2 - (m.token.left + m.token.right) / 2) <= 0.6, where);
      assert.ok(Math.abs(m.limits.width - m.token.width) <= 0.6, where);
    }
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
    } finally { await context.close(); }
  }
});
