// the ready-to-test marker is a folded top right corner on the ticket, not a
// fill. checked without a browser on every surface that lists tickets: the
// desktop board (index.html with card-tokens.css), the phone (m.html with
// card-tokens.css) and the typed page (page.html, which carries its own copy).
// each surface's real row painter is run over a pool of cards so the testc
// class is seen landing on the ready-to-test row alone and on no other; each
// surface's stylesheet is read so testc is seen drawing the fold and nothing
// else: no bluish fill, no edge of its own, a pure white underside, and every
// line the fold draws taken from the board's own edge settings, the free edges
// as borders at --edge like a ticket's and the painted crease at --edge-drawn,
// the width those borders are drawn at on each screen. nothing here renders a
// pixel.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const TOKENS = read("card-tokens.css");
const styleOf = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");

// each page's own sheet, then the shared one where the page links it: the
// order the browser cascades them in
const SURFACES = {
  "the desktop board": { file: "index.html", tokens: true, fold: 16 },
  "the phone": { file: "m.html", tokens: true, fold: 12 },
  "the typed page": { file: "page.html", tokens: false, fold: 16 },
};
for (const s of Object.values(SURFACES)) {
  s.html = read(s.file);
  s.css = styleOf(s.html) + (s.tokens ? "\n" + TOKENS : "");
}

// ---- a small reader for the sheets ------------------------------------------------
// rules are read as [selector, body, enclosing at-rules]; strings are skipped
// whole so a brace inside one cannot unbalance the walk
function rulesOf(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [], stack = [];
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = css.indexOf(c, i + 1);
      buf += css.slice(i, end + 1);
      i = end;
    } else if (c === "{") { stack.push(buf.trim()); buf = ""; }
    else if (c === "}") {
      const sel = stack.pop();
      if (sel && !sel.startsWith("@") && !stack.some(s => s.startsWith("@keyframes")))
        out.push({ sel, sels: sel.split(",").map(x => x.trim().replace(/\s+/g, " ")), body: buf, at: stack.filter(s => s.startsWith("@")) });
      buf = "";
    } else buf += c;
  }
  return out;
}
function declsOf(body) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (const c of body) {
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === ";" && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map(d => d.trim()).filter(Boolean).map(d => {
    const at = d.indexOf(":");
    return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim().replace(/\s+/g, " ")];
  });
}
// every top-level declaration for one exact selector, later ones winning
function style(css, selector) {
  const got = {};
  for (const r of rulesOf(css)) if (!r.at.length && r.sels.includes(selector))
    for (const [p, v] of declsOf(r.body)) got[p] = v;
  return got;
}
// a custom property as the sheet leaves it on :root, then on the row
function custom(css, name, rowSelectors) {
  let v;
  for (const sel of [":root", ...rowSelectors]) if (style(css, sel)[name] != null) v = style(css, sel)[name];
  return v;
}
const px = v => { const m = /^(-?[\d.]+)px$/.exec(v || ""); return m ? Number(m[1]) : NaN; };
// a length as written, a plain px or a calc() of them, worked out
function lengthOf(v) {
  if (v == null) return NaN;
  const t = v.replace(/calc/g, "").replace(/px/g, "");
  assert.match(t, /^[\d\s.+\-*/()]+$/, `an unexpected length: ${v}`);
  return Function(`return (${t});`)();
}
// a custom property as a 1x, 2x and 3x screen each sees it: the plain :root
// value, then every min-resolution step at or under that density, in sheet order
function perResolution(css, name) {
  const out = {};
  for (const dppx of [1, 2, 3]) {
    let v;
    for (const r of rulesOf(css)) {
      if (!r.sels.includes(":root")) continue;
      const step = r.at.length ? /min-resolution:\s*([\d.]+)dppx/.exec(r.at.join(" ")) : null;
      if (r.at.length && (!step || Number(step[1]) > dppx)) continue;
      for (const [p, value] of declsOf(r.body)) if (p === name) v = value;
    }
    out[dppx] = lengthOf(v);
  }
  return out;
}

// a polygon() as numbers for one box: percentages of the box, var(--fold),
// var(--edge) and var(--edge-drawn) swapped for their lengths, the calc()
// arithmetic worked out
function polygon(value, box, lengths) {
  const inner = /polygon\(([\s\S]*)\)/.exec(value)[1];
  const parts = [];
  let depth = 0, cur = "";
  for (const c of inner) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += c;
  }
  parts.push(cur.trim());
  const num = (term, whole) => {
    let t = term.replace(/var\(--edge-drawn\)/g, lengths.drawn + "px").replace(/var\(--edge\)/g, lengths.edge + "px")
      .replace(/var\(--fold\)/g, lengths.fold + "px")
      .replace(/([\d.]+)%/g, (_, n) => String(Number(n) / 100 * whole) + "px")
      .replace(/calc/g, "").replace(/px/g, "");
    assert.match(t, /^[\d\s.+\-*/()]+$/, `an unexpected term in the polygon: ${term}`);
    return Function(`return (${t});`)();
  };
  return parts.map(p => {
    const terms = [];
    let d = 0, c = "";
    for (const ch of p) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === " " && d === 0) { if (c) terms.push(c); c = ""; } else c += ch;
    }
    if (c) terms.push(c);
    assert.equal(terms.length, 2, `a polygon point is not an x and a y: ${p}`);
    return [num(terms[0], box.w), num(terms[1], box.h)];
  });
}
function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-3, `${what}: ${a} is not ${b}`);

// ---- the row painters, run over a pool with the card logic the pages load ----------
const noop = () => {};
class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tagName = String(tag).toUpperCase();
    this.className = className || "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this._text = String(text ?? "");
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...n) => { this.className = [...new Set([...names(), ...n])].join(" "); },
      contains: n => names().includes(n),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  setAttribute() {}
  addEventListener() {}
  get offsetHeight() { return 40; }
  getBoundingClientRect() { return { top: (this.parentElement ? this.parentElement.children.indexOf(this) : 0) * 40 }; }
  querySelector(selector) {
    if (selector !== ".trow.on") throw new Error(`unsupported selector: ${selector}`);
    return this.children.find(c => c.classList && c.classList.contains("trow") && c.classList.contains("on")) || null;
  }
  scrollIntoView() {}
}
const sandbox = {
  document: { createElement: tag => new FakeElement(tag), getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: new FakeElement("body") },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
const { cardState, queueState, testReady, appendOmniRowArt } = sandbox;
const h = (tag, className, text) => new FakeElement(tag, className, text);

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}
const NOW = 1_000_000_000;
const DateStub = { now: () => NOW * 1000 };
const SPIN = ["|", "/", "-", "\\"];

// each surface's painter, handed one pool, answers with the rows it drew
const PAINT = {
  "the desktop board": pool => {
    const paint = new Function("Date", "queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      `${functionSource(SURFACES["the desktop board"].html, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(DateStub, queueState, cardState, h, {}, () => "5m", SPIN, 0, () => "todo", "none", null, testReady, appendOmniRowArt);
    const pane = new FakeElement("div");
    paint(pane, pool, "todo", { agents: {} }, "lane");
    return pane.children;
  },
  "the phone": pool => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "selectedId", "testReady", "appendOmniRowArt",
      `${functionSource(SURFACES["the phone"].html, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, () => "5m", SPIN, 0, "none", testReady, appendOmniRowArt);
    const pane = new FakeElement("div");
    paint(pane, pool, "todo", "sig", { agents: {} });
    return pane.children;
  },
  "the typed page": pool => {
    const tiklist = new FakeElement("div"), chips = new FakeElement("div");
    const document = { getElementById: id => ({ tiklist, chips })[id] };
    const render = new Function("document", "Date", "curWs", "poolOf", "viewFilter", "queueState",
      "cardState", "h", "seenReplies", "shortAge", "syncSpinner", "SPIN_FRAMES", "spinFrame", "activeOwner",
      "curView", "paintViewTabs", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      `${functionSource(SURFACES["the typed page"].html, "renderCarousel", "ord")}; return renderCarousel;`,
    )(document, DateStub, () => null, state => state.boxes, () => true, queueState, cardState, h, {},
      () => "5m", noop, SPIN, 0, "lane", () => "todo", noop, "none", null, testReady, appendOmniRowArt);
    render({ agents: {}, boxes: pool });
    return tiklist.children;
  },
};

// one card in each state a row can be in, every one of them flagged, and a
// ready-to-test card beside an unflagged twin. only a flagged card awaiting the
// reader is ready to test; the rest keep the flag and must not show it
const reply = { ball: "you", replies: 1, agentTs: NOW - 300, pending: 0 };
const POOL = [
  { id: "m1", title: "Ready to test", state: "yours", ...reply, testing: true },
  { id: "m2", title: "Awaiting the reader", state: "yours", ...reply, testing: false },
  { id: "m3", title: "Omni Ticket #2", state: "yours", ...reply, testing: true },
  { id: "m4", title: "Back at work", state: "working", ball: "me", writing: true, testing: true },
  { id: "m5", title: "Queued behind a message", state: "queued", ball: "me", pending: 1, agentTs: NOW - 300, testing: true },
  { id: "m6", title: "A new card", state: "new", ball: "me", testing: true },
  { id: "m7", title: "Closed", state: "done", done: true, testing: true },
].map(b => ({ owner: "lane", bg: false, task: "", ...b }));
const classesOf = rows => Object.fromEntries(rows.filter(r => r.dataset.id).map(r => [r.dataset.id, r.className.split(/\s+/)]));

for (const [where, surface] of Object.entries(SURFACES)) {
  test(`${where}: the ready-to-test row alone carries the fold's class, and every other class is as it was`, () => {
    const marked = classesOf(PAINT[where](POOL));
    const plain = classesOf(PAINT[where](POOL.map(b => ({ ...b, testing: false }))));
    // the typed page lists open cards on its doing view and leaves the done one out
    const ids = where === "the typed page" ? ["m1", "m2", "m3", "m4", "m5", "m6"] : POOL.map(b => b.id);
    assert.deepEqual(Object.keys(marked).sort(), ids.sort(), "the painter drew a different set of rows");
    for (const id of ids) {
      const ready = id === "m1" || id === "m3";
      assert.equal(marked[id].includes("testc"), ready, `${id} ${ready ? "lost" : "gained"} the fold's class`);
      // taking the flag away takes testc away and nothing else: the row's own
      // state, seen, omni and selection classes are the ones it always had
      assert.deepEqual(marked[id].filter(c => c !== "testc"), plain[id], `${id} changed more than the fold's class`);
      assert.ok(!plain[id].includes("testc"), `${id} wears the fold with no flag`);
    }
    assert.ok(marked.m1.includes("yours") && marked.m3.includes("omni-ticket"),
      "a ready-to-test row is not also the awaiting (or omni) row it would otherwise be");
  });

  test(`${where}: testc draws the fold and nothing else, with no bluish fill left anywhere`, () => {
    const css = surface.css;
    assert.doesNotMatch(css, /#EBEFFF/i, "the old bluish ready-to-test fill is still in the sheet");
    assert.doesNotMatch(css, /testc:not\(\.on\)/, "the old ready-to-test edge rule is still in the sheet");
    assert.doesNotMatch(css, /--fold-edge/, "the fold still keeps an edge width of its own");
    const foldSelectors = [".trow.testc", ".trow.testc::before", ".trow.testc::after"];
    for (const r of rulesOf(css)) {
      if (!r.sel.includes("testc")) continue;
      assert.deepEqual(r.at, [], `a ready-to-test rule sits inside ${r.at.join(" ")}`);
      for (const s of r.sels) assert.ok(foldSelectors.includes(s), `testc is used by a rule that is not the fold: ${r.sel}`);
      if (r.sels.includes(".trow.testc")) {
        // on the row itself: only the cut and the fold's own measures. no
        // fill, no edge, no shade, no opacity: the row keeps its own look
        for (const [p] of declsOf(r.body))
          assert.ok(p === "clip-path" || p === "--fold", `the ready-to-test row sets ${p} on itself`);
      }
    }
  });

  test(`${where}: the corner is cut along the crease and the flap is its mirror, white, with the ticket's corner at the tip`, () => {
    const css = surface.css;
    const fold = px(custom(css, "--fold", [".trow", ".trow.testc"]));
    // the cut and the crease layer's triangle read no edge width; these only fill the evaluator
    const edge = .8, drawn = 1;
    assert.equal(fold, surface.fold, `the fold is not ${surface.fold}px here`);
    // each layer's declarations, the rule the two share included
    const row = style(css, ".trow.testc");
    const crease = style(css, ".trow.testc::before");
    const flap = style(css, ".trow.testc::after");

    // the cut, measured on the padding box the flap is positioned in, so the
    // two share one crease whatever the row's edge width is
    assert.match(row["clip-path"], /\)\s*padding-box$/, "the cut is not measured on the padding box");
    const box = { w: 300, h: 64 };
    const cut = polygon(row["clip-path"], box, { fold, edge, drawn });
    const w = box.w;
    // the crease runs from --fold in along the top edge to --fold down the right
    const onCrease = cut.filter(([x, y]) => Math.abs((x - y) - (w - fold)) < 1e-6);
    assert.equal(onCrease.length, 2, "the cut has no single crease line");
    assert.ok(!inside([w - 1, 1], cut) && !inside([w - fold / 2 + 0.5, fold / 2 - 0.5], cut), "the corner is not cut away");
    assert.ok(inside([w - fold - 0.5, 0.5], cut) && inside([w - 0.5, fold + 0.5], cut), "the cut reaches past the crease");
    assert.ok(inside([2, box.h - 2], cut) && inside([2, 2], cut) && inside([w - 2, box.h - 2], cut), "the cut takes more than the corner");
    // the selected row's lift shade (0 2px 18px) survives everywhere but beyond the crease
    assert.ok(inside([-20, box.h + 20], cut) && inside([w + 20, box.h + 20], cut) && inside([-20, -20], cut),
      "the cut clips the row's shade away from the crease");

    // both layers are one --fold square in the top right of the padding box
    for (const layer of [crease, flap]) {
      assert.equal(layer.content, '""');
      assert.equal(layer.position, "absolute");
      assert.equal(layer.top, "0");
      assert.equal(layer.right, "0");
      assert.equal(layer["box-sizing"], "border-box");
      assert.equal(layer.width, "var(--fold)");
      assert.equal(layer.height, "var(--fold)");
      assert.equal(layer["pointer-events"], "none");
      // the ticket's own corner at the flap's tip: the mirror of the corner cut away
      assert.equal(layer["border-bottom-left-radius"], style(css, ".trow")["border-radius"], "the tip is not the ticket's corner");
    }
    // the crease layer is the triangle on the flap's side of the diagonal, and
    // it is the mirror of the corner the cut takes: reflecting the cut corner
    // across the crease lands exactly on it
    const square = { w: fold, h: fold };
    const tri = polygon(crease["clip-path"], square, { fold, edge, drawn }).map(([x, y]) => [x + w - fold, y]);
    const cutCorner = [[w - fold, 0], [w, 0], [w, fold]];
    const mirror = ([x, y]) => [y + (w - fold), x - (w - fold)];
    const key = pts => pts.map(p => p.map(n => n.toFixed(4)).join(",")).sort();
    assert.deepEqual(key(cutCorner.map(mirror)), key(tri), "the flap is not the cut corner's mirror across the crease");

    // the backside is pure white, with no gradient or wash laid over it
    assert.equal(flap.background, "#ffffff", "the flap's underside is not #ffffff");
    assert.equal(crease.background, "var(--line)", "the crease is not drawn in the ticket edge grey");
    // a thin soft shade under the free edges, from the light overhead
    assert.match(flap["box-shadow"], /^0 1px 2px rgba\(60,45,20,\.16\)$/, "the flap's shade is not the thin one");
  });

  test(`${where}: every line the fold draws is the ticket edge, read from the board's own edge settings`, () => {
    const css = surface.css;
    const fold = px(custom(css, "--fold", [".trow", ".trow.testc"]));
    const flap = style(css, ".trow.testc::after");
    // the two free edges are borders asked for exactly what a ticket edge is
    // asked for, so the browser snaps both to the same device pixel
    const ticketEdge = style(css, ".trow").border;
    assert.equal(ticketEdge, "var(--edge) solid var(--line)", "the ticket edge no longer reads --edge");
    assert.equal(flap["border-left"], ticketEdge, "the flap's left edge is not the ticket edge");
    assert.equal(flap["border-bottom"], ticketEdge, "the flap's bottom edge is not the ticket edge");
    // no other side drawn, and no width of the fold's own anywhere in its rules
    for (const r of rulesOf(css)) if (r.sel.includes("testc"))
      for (const [p, v] of declsOf(r.body)) {
        if (p.startsWith("border") && p !== "border-bottom-left-radius")
          assert.ok(p === "border-left" || p === "border-bottom", `the fold draws ${p}: ${v}`);
        assert.doesNotMatch(v, /(^|[^\d])0?\.8px/, `the fold writes the edge width out itself: ${p}:${v}`);
      }
    // the shared settings as each screen sees them: --edge asked at 0.8px, and
    // --edge-drawn the width chrome actually draws that border at. chrome
    // floors a border to whole device pixels and never below one, so 0.8px is
    // one device pixel at 1x (1px) and 2x (0.5px) and two at 3x (2/3px)
    const edge = perResolution(css, "--edge"), drawn = perResolution(css, "--edge-drawn");
    // the crease is paint, not a border, so it reads the drawn width and never the asked one
    assert.match(flap["clip-path"], /var\(--edge-drawn\)/, "the crease does not read --edge-drawn");
    assert.doesNotMatch(flap["clip-path"], /var\(--edge\)/, "the crease reads the asked width, which is never drawn");
    for (const dppx of [1, 2, 3]) {
      near(edge[dppx], .8, `--edge at ${dppx}x`);
      const snapped = Math.max(1, Math.floor(edge[dppx] * dppx + 1e-9)) / dppx;
      near(drawn[dppx], snapped, `--edge-drawn at ${dppx}x is not the width a ticket edge is drawn at`);
      // the flap is clipped short of the diagonal by exactly that drawn width,
      // measured square to the crease, so the band of the grey layer beneath
      // that shows along it is as wide as the borders it meets
      const e = drawn[dppx];
      const flapClip = polygon(flap["clip-path"], { w: fold, h: fold }, { fold, edge: edge[dppx], drawn: e });
      const shifted = flapClip.filter(([x, y]) => Math.abs(y - x - e * Math.SQRT2) < 1e-3);
      assert.equal(shifted.length, 2, `at ${dppx}x the flap is not clipped along a line parallel to the crease`);
      near((shifted[0][1] - shifted[0][0]) / Math.SQRT2, snapped, `at ${dppx}x the crease band is not the drawn edge width`);
      assert.ok(!inside([fold / 2, fold / 2 + e * Math.SQRT2 - 0.01], flapClip), `at ${dppx}x the flap covers the crease band`);
      assert.ok(inside([fold / 2 - 3, fold / 2 + 3], flapClip) && inside([-3, fold + 3], flapClip),
        `at ${dppx}x the flap, or its shade beyond its free edges, is clipped away`);
    }
  });

  test(`${where}: the other ticket states keep their own looks`, () => {
    const css = surface.css;
    const fills = {
      ".trow": ["background", "#fff"],
      ".trow.working": ["background", "#F3FFF0"],
      ".trow.yours": ["background", "#FFFBEB"],
      ".trow.queuedc": ["background", "#F7F7F7"],
      ".trow.donec": ["opacity", ".55"],
      ".trow.omni-ticket": ["background", "#fff"],
    };
    if (where !== "the phone") fills[".trow.match"] = ["background", "var(--accent-soft)"];
    for (const [sel, [prop, want]] of Object.entries(fills)) {
      const got = style(css, sel);
      assert.equal(got[prop], want, `${sel} no longer reads ${prop} ${want}`);
      assert.equal(got["clip-path"], undefined, `${sel} was cut`);
    }
    // the base row keeps its own edge, corner and shade, and the selected row
    // its lift, with no ready-to-test exception left beside either
    const base = style(css, ".trow");
    assert.equal(base["border-radius"], "5px");
    assert.equal(base.border, "var(--edge) solid var(--line)");
    assert.equal(base["box-shadow"], "0 1px 4px rgba(60,45,20,.05)");
    assert.equal(base.overflow, "hidden");
    assert.equal(style(css, ".trow.on").transform, "translateY(-1px)");
  });
}

test("the typed page keeps its fold, its edge settings and its gate in step with the shared ones", () => {
  const page = SURFACES["the typed page"].css;
  // the page does not load card-tokens.css, so the fold there reads the page's
  // own copies of the edge settings; they must be the shared ones on every screen
  for (const name of ["--edge", "--edge-drawn"]) {
    const own = perResolution(styleOf(SURFACES["the typed page"].html), name);
    assert.ok([1, 2, 3].every(d => Number.isFinite(own[d])), `the typed page has no ${name} of its own`);
    assert.deepEqual(own, perResolution(TOKENS, name), `the typed page's ${name} drifted from card-tokens.css`);
  }
  for (const sel of [".trow.testc::before", ".trow.testc::after"]) {
    const drawn = style(page, sel);
    assert.ok(Object.keys(drawn).length > 5, `${sel} is not on the typed page`);
    assert.deepEqual(drawn, style(TOKENS, sel), `${sel} drifted from card-tokens.css`);
  }
  assert.equal(style(page, ".trow.testc")["clip-path"], style(TOKENS, ".trow.testc")["clip-path"], "the cut drifted from card-tokens.css");
  const gate = /function testReady\(b\)\{[^\n]*\}/;
  assert.equal(gate.exec(SURFACES["the typed page"].html)[0], gate.exec(read("card-logic.js"))[0],
    "the typed page's ready-to-test gate drifted from card-logic.js");
});
