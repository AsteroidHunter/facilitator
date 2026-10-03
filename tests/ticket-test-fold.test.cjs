// the ready-to-test marker is a folded top right corner on the ticket, not a
// fill. checked without a browser on every surface that lists tickets: the
// desktop board (index.html with card-tokens.css), the phone (m.html with
// card-tokens.css) and the typed page (page.html, which carries its own copy).
// each surface's real row painter is run over a pool of cards so the testc
// class is seen landing on the ready-to-test row alone and on no other; each
// surface's stylesheet is read so testc is seen drawing the fold and nothing
// else: no bluish fill, the ticket's own fill, edge and shades handed to a cut
// face and a drop-shadow that follows the cut, the flap the exact mirror of
// the cut corner with a pure white underside, the approved mock's crease and
// thin cast shadows, and every line the fold draws taken from the board's own
// edge settings, the free edges as borders at --edge like a ticket's and the
// painted crease at --edge-drawn, the width those borders are drawn at on each
// screen. nothing here renders a pixel.
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

// one length term as a number of px: percentages of `whole`, var(--fold),
// var(--edge) and var(--edge-drawn) swapped for their lengths, the calc()
// arithmetic worked out
function measure(term, whole, lengths) {
  const t = term.replace(/var\(--edge-drawn\)/g, lengths.drawn + "px").replace(/var\(--edge\)/g, lengths.edge + "px")
    .replace(/var\(--fold\)/g, lengths.fold + "px")
    .replace(/([\d.]+)%/g, (_, n) => String(Number(n) / 100 * whole) + "px")
    .replace(/calc/g, "").replace(/px/g, "");
  assert.match(t, /^[\d\s.+\-*/()]+$/, `an unexpected length term: ${term}`);
  return Function(`return (${t});`)();
}
// split a function's arguments at its top-level commas
function args(value, name) {
  const at = value.indexOf(name + "(");
  assert.ok(at >= 0, `no ${name}() in ${value}`);
  const out = [];
  let depth = 0, cur = "";
  for (const c of value.slice(at + name.length + 1)) {
    if (c === "(") depth++;
    if (c === ")") { if (depth === 0) break; depth--; }
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}
// a linear-gradient() as its direction and its stops, each stop's colour and
// its place as px along the gradient line of the given length
function gradient(value, length, lengths) {
  const [direction, ...stops] = args(value, "linear-gradient");
  return {
    direction,
    stops: stops.map(s => {
      const m = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*(.*)$/i.exec(s);
      assert.ok(m, `an unexpected gradient stop: ${s}`);
      return { colour: m[1], at: m[2] ? measure(m[2], length, lengths) : null };
    }),
  };
}
// a box-shadow or a run of drop-shadow() filters as [x, y, blur, colour] layers
function shades(value) {
  const layers = value.startsWith("drop-shadow(")
    ? [...value.matchAll(/drop-shadow\(([^()]*\([^()]*\)[^()]*|[^()]*)\)/g)].map(m => m[1])
    : value.split(/,(?![^(]*\))/);
  return layers.map(l => {
    const colour = /rgba?\([^)]*\)/.exec(l)[0];
    const [x, y, blur] = l.replace(colour, "").trim().split(/\s+/).map(n => px(n === "0" ? "0px" : n));
    return [x, y, blur, colour.replace(/\s+/g, "")];
  });
}
const luma = hex => { const n = parseInt(hex.slice(1), 16); return .299 * (n >> 16) + .587 * ((n >> 8) & 255) + .114 * (n & 255); };

// a polygon() as numbers for one box, each term worked out by measure()
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
  const num = (term, whole) => measure(term, whole, lengths);
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
  get firstElementChild() { return this.children[0] || null; }
  insertBefore(child, ref) {
    child.parentElement = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
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
      "SPIN_FRAMES", "spinFrame", "selectedId", "testReady", "appendOmniRowArt", "omniRowFace",
      `${functionSource(SURFACES["the phone"].html, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, () => "5m", SPIN, 0, "none", testReady, appendOmniRowArt, sandbox.omniRowFace);
    const pane = new FakeElement("div");
    paint(pane, pool, "todo", { agents: {} }, noop);
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
    const foldSelectors = [".trow.testc", ".trow.testc.on", ".trow.testc::before", ".trow.testc::after",
      ".trow.testc > .trowin::before", ".trow.testc > .omni-sweep"];
    // what the row itself may say: it hands its edge and shade to the face
    // and the filter and keeps its fill, so it never sets a fill, an opacity
    // or a colour of its own
    const rowMay = ["--fold", "-webkit-background-clip", "background-clip", "border-color", "box-shadow", "overflow", "filter"];
    const rules = rulesOf(css);
    for (const r of rules) {
      if (!r.sel.includes("testc")) continue;
      assert.deepEqual(r.at, [], `a ready-to-test rule sits inside ${r.at.join(" ")}`);
      for (const s of r.sels) assert.ok(foldSelectors.includes(s), `testc is used by a rule that is not the fold: ${r.sel}`);
      if (r.sels.includes(".trow.testc") || r.sels.includes(".trow.testc.on"))
        for (const [p] of declsOf(r.body)) assert.ok(rowMay.includes(p), `the ready-to-test row sets ${p} on itself`);
    }
    const row = style(css, ".trow.testc");
    assert.equal(row["background-clip"], "text");
    assert.equal(row["-webkit-background-clip"], "text");
    assert.equal(row["border-color"], "transparent");
    assert.equal(row["box-shadow"], "none");
    assert.equal(row.overflow, "visible");
    assert.equal(row["clip-path"], undefined, "the row cuts itself, which cuts its shade along the crease's line");
    // the row's hand-over only works if it comes after every rule of the same
    // weight that sets a row's fill, edge or shade, the omni face's shorthand
    // included, since that shorthand puts the fill's clip back
    const lastOf = pred => rules.reduce((at, r, i) => (pred(r) ? i : at), -1);
    const handOver = lastOf(r => r.sels.includes(".trow.testc") && /background-clip/.test(r.body));
    for (const sel of [".trow:hover", ".trow.working", ".trow.yours", ".trow.queuedc", ".trow.match", ".trow.on", ".trow.omni-ticket"]) {
      const at = lastOf(r => !r.at.length && r.sels.includes(sel));
      assert.ok(at < handOver, `${sel} comes after the ready-to-test row's hand-over and would win`);
    }
  });

  test(`${where}: the row's shade is a drop-shadow of the cut ticket, the ticket's own two shades`, () => {
    const css = surface.css;
    // a filter runs before a clip on one element, so the shade follows the cut
    // only because the cut is on ::before and the filter on the row
    const row = style(css, ".trow.testc"), on = style(css, ".trow.testc.on");
    const key = layers => layers.map(l => l.join(" ")).sort();
    assert.deepEqual(key(shades(row.filter)), key(shades(style(css, ".trow")["box-shadow"])),
      "the ready-to-test row's shade is not the ticket's own");
    assert.equal(on["box-shadow"], "none");
    assert.deepEqual(key(shades(on.filter)), key(shades(style(css, ".trow.on")["box-shadow"])),
      "the selected ready-to-test row's lift is not the selected ticket's own");
    // the face paints under the row's words, which needs the row to be its
    // own stacking context: its filter makes it one
    const face = style(css, ".trow.testc::before");
    assert.equal(face["z-index"], "-1");
    assert.notEqual(row.filter, "none");
    assert.notEqual(on.filter, "none");
    if (surface.tokens) {
      const sweep = style(css, ".trow.testc > .omni-sweep");
      assert.equal(sweep["border-radius"], "inherit");
      assert.equal(sweep.overflow, "hidden", "the omni light is no longer kept to the rounded ticket");
    }
  });

  test(`${where}: the corner is cut along the crease and the flap is its mirror, white, with the ticket's corner at the tip`, () => {
    const css = surface.css;
    const fold = px(custom(css, "--fold", [".trow", ".trow.testc"]));
    // the cut and the crease layer's triangle read no edge width; these only fill the evaluator
    const edge = .8, drawn = 1;
    assert.equal(fold, surface.fold, `the fold is not ${surface.fold}px here`);
    // each layer's declarations, the rule the layers share included
    const face = style(css, ".trow.testc::before");
    const flap = style(css, ".trow.testc::after");
    const hole = style(css, ".trow.testc > .trowin::before");
    const ticket = style(css, ".trow");

    // all three are placed on the border box: the row's edge is drawn
    // --edge-drawn wide, so that far out from the padding box they are placed from
    for (const layer of [face, flap, hole]) {
      assert.equal(layer.content, '""');
      assert.equal(layer.position, "absolute");
      assert.equal(layer["box-sizing"], "border-box");
      assert.equal(layer["pointer-events"], "none");
    }
    assert.equal(face.inset, "calc(-1 * var(--edge-drawn))");
    for (const layer of [flap, hole]) {
      assert.equal(layer.top, "calc(-1 * var(--edge-drawn))");
      assert.equal(layer.right, "calc(-1 * var(--edge-drawn))");
      assert.equal(layer.width, "var(--fold)");
      assert.equal(layer.height, "var(--fold)");
    }
    // the face is the ticket as the row would paint it: the fill the row's
    // state gives it, the ticket's edge and its corners
    assert.equal(face["background-color"], "inherit", "the face does not take the row's own fill");
    assert.equal(face.border, ticket.border, "the face's edge is not the ticket's");
    assert.equal(face["border-radius"], "inherit");
    assert.equal(ticket["border-radius"], "5px");

    // the cut, on the face: only the corner beyond the crease goes; the other
    // corners are the rectangle's own, so the ticket's rounding keeps them
    const box = { w: 300, h: 64 }, w = box.w, L = { fold, edge, drawn };
    const cut = polygon(face["clip-path"], box, L);
    const onCrease = cut.filter(([x, y]) => Math.abs((x - y) - (w - fold)) < 1e-6);
    assert.equal(onCrease.length, 2, "the cut has no single crease line");
    const key = pts => pts.map(p => p.map(n => n.toFixed(4)).join(",")).sort();
    assert.deepEqual(key(cut), key([[0, 0], [w - fold, 0], [w, fold], [w, box.h], [0, box.h]]), "the cut takes more than the corner");

    // the flap is the corner the cut takes, reflected across the crease, and
    // the hole is exactly the corner: every point of the corner square is on
    // one side or the other, checked on a grid kept off the diagonal
    const flapClip = polygon(flap["clip-path"], { w: fold, h: fold }, L);
    const holeClip = polygon(hole["clip-path"], { w: fold, h: fold }, L);
    const mirror = ([x, y]) => [y + (w - fold), x - (w - fold)];
    const toSquare = ([x, y]) => [x - (w - fold), y];
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
      const p = [w - fold + (i + .37) * fold / 16, (j + .61) * fold / 16];
      const gone = !inside(p, cut);
      assert.equal(inside(toSquare(mirror(p)), flapClip), gone, `the flap is not the mirror of the cut at ${p}`);
      assert.equal(inside(toSquare(p), holeClip), gone, `the hole is not the cut corner at ${p}`);
    }
    // the flap's outer side is the crease itself, so the clip keeps it sharp
    const k = flapClip.findIndex(([x, y]) => Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);
    const next = flapClip[(k + 1) % flapClip.length];
    assert.ok(k >= 0 && Math.abs(next[0] - fold) < 1e-6 && Math.abs(next[1] - fold) < 1e-6,
      "the flap is not cut exactly on the crease");
    // the ticket's own corner at the flap's tip: the mirror of the rounded corner cut away
    assert.equal(flap["border-bottom-left-radius"], "inherit", "the tip is not the ticket's corner");

    // the underside, across the flap from the crease to its tip: it ends pure
    // white, and the only other colour is the crease line at the crease
    const across = gradient(flap.background, fold * Math.SQRT2, { fold, edge, drawn });
    assert.equal(across.direction, "to bottom left", "the flap's face does not run from the crease to the tip");
    assert.equal(across.stops.at(-1).colour.toLowerCase(), "#ffffff", "the flap's underside is not #ffffff");
    assert.equal(across.stops.length, 2, "the underside carries a wash besides the crease");
    const crease = across.stops[0].colour;
    assert.equal(crease.toUpperCase(), "#AD9D7F", "the crease is not the approved mock's crease line");
    assert.ok(luma(crease) < luma("#CACACA") - 40, "the crease is not clearly darker than an edge, so it cannot show the fold");

    // the flap's cast shadow is the mock's: a tight one and a faint soft one,
    // moved a little down and left so they hug the free edges, and thin: no
    // layer reaches more than about 3px past the edge it hugs
    const cast = shades(flap["box-shadow"]);
    assert.deepEqual(cast.map(l => l.join(" ")),
      ["-0.25 0.5 1.1 rgba(60,45,20,.22)", "-0.4 0.9 2.2 rgba(60,45,20,.08)"], "the flap's shadow is not the mock's pair");
    for (const [x, y, blur] of cast) {
      assert.ok(x < 0 && y > 0 && Math.abs(x) < y, "a flap shadow does not fall down and a little left");
      assert.ok(y + blur <= 3.1, "a flap shadow spreads wider than a thin one");
    }
    // the hole's contact shade starts at the crease and is gone within an
    // eighth of the diagonal, faint throughout
    const contact = gradient(hole.background, fold * Math.SQRT2, { fold, edge, drawn });
    assert.equal(contact.direction, "to top right");
    assert.deepEqual(contact.stops.map(s => s.colour), ["rgba(60,45,20,.08)", "rgba(60,45,20,0)"]);
    near(contact.stops[0].at, fold * Math.SQRT2 / 2, "the contact shade does not start at the crease");
    assert.ok(contact.stops[1].at - contact.stops[0].at <= fold * Math.SQRT2 / 8, "the contact shade reaches too far");
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
    assert.equal(style(css, ".trow.testc::before").border, ticketEdge, "the face's edge is not the ticket edge");
    // no other side drawn, and no width of the fold's own anywhere in its rules
    for (const r of rulesOf(css)) if (r.sel.includes("testc"))
      for (const [p, v] of declsOf(r.body)) {
        if (p.startsWith("border") && !p.endsWith("radius") && p !== "border-color")
          assert.ok(p === "border-left" || p === "border-bottom" || (p === "border" && r.sels.includes(".trow.testc::before")),
            `the fold draws ${p}: ${v}`);
        assert.doesNotMatch(v, /(^|[^\d])0?\.8px/, `the fold writes the edge width out itself: ${p}:${v}`);
      }
    // the shared settings as each screen sees them: --edge asked at 0.8px, and
    // --edge-drawn the width chrome actually draws that border at. chrome
    // floors a border to whole device pixels and never below one, so 0.8px is
    // one device pixel at 1x (1px) and 2x (0.5px) and two at 3x (2/3px)
    const edge = perResolution(css, "--edge"), drawn = perResolution(css, "--edge-drawn");
    // the crease is paint, not a border, so it reads the drawn width and never the asked one
    assert.match(flap.background, /var\(--edge-drawn\)/, "the crease does not read --edge-drawn");
    assert.doesNotMatch(flap.background, /var\(--edge\)/, "the crease reads the asked width, which is never drawn");
    for (const dppx of [1, 2, 3]) {
      near(edge[dppx], .8, `--edge at ${dppx}x`);
      const snapped = Math.max(1, Math.floor(edge[dppx] * dppx + 1e-9)) / dppx;
      near(drawn[dppx], snapped, `--edge-drawn at ${dppx}x is not the width a ticket edge is drawn at`);
      // from the crease, which the flap's clip keeps sharp, the face is the
      // crease colour for half a drawn edge and then ramps to white over one
      // more, the way a device pixel softens an edge: the line it draws is
      // exactly one drawn edge wide, the width of the borders it meets
      const e = drawn[dppx], diag = fold * Math.SQRT2;
      const [line, white] = gradient(flap.background, diag, { fold, edge: edge[dppx], drawn: e }).stops;
      near(line.at - diag / 2, snapped / 2, `at ${dppx}x the crease's solid part`);
      near(white.at - line.at, snapped, `at ${dppx}x the crease's soft inner side`);
      near((line.at - diag / 2) + (white.at - line.at) / 2, snapped, `at ${dppx}x the crease is not one drawn edge wide`);
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
  for (const sel of [".trow.testc::before", ".trow.testc::after", ".trow.testc > .trowin::before", ".trow.testc.on"]) {
    const drawn = style(page, sel);
    assert.ok(Object.keys(drawn).length > 1, `${sel} is not on the typed page`);
    assert.deepEqual(drawn, style(TOKENS, sel), `${sel} drifted from card-tokens.css`);
  }
  // the row's hand-over, less the page's own --fold (the shared one is on :root)
  const { "--fold": fold, ...row } = style(page, ".trow.testc");
  assert.equal(fold, "16px");
  assert.deepEqual(row, style(TOKENS, ".trow.testc"), "the row's hand-over drifted from card-tokens.css");
  const gate = /function testReady\(b\)\{[^\n]*\}/;
  assert.equal(gate.exec(SURFACES["the typed page"].html)[0], gate.exec(read("card-logic.js"))[0],
    "the typed page's ready-to-test gate drifted from card-logic.js");
});
