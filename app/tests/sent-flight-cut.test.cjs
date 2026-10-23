// A send's flight is cut where the card shows its foot. The flight stands
// outside the card, over everything, so the boxes that cut the card's own foot
// cannot cut it; it starts as the typing row and lands on the new bubble, and a
// long message grows the row to its cap, which on a card laid out shorter than
// that cap reaches past what the card shows of it, as the bubble it lands on can.
// Uncut, the flight drew those parts over the card's head and past its edge. The
// stand-in page here lays out boxes by hand; no layout engine and no browser
// runs, so nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const { drawn } = require("./sent-flight-drawn.cjs");
const ROOT = path.join(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const FLIGHT_MS = 650;

// ---- a stand-in page: boxes laid out by hand, each with how it treats overflow ----------
const kebab = name => name.startsWith("--") ? name : name.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
function inline() {
  const props = {};
  const api = {
    setProperty(name, value) { props[kebab(name)] = String(value); },
    getPropertyValue(name) { return props[kebab(name)] || ""; },
    getPropertyPriority() { return ""; },
    removeProperty(name) { delete props[kebab(name)]; },
  };
  return new Proxy(api, {
    get: (target, key) => key in target ? target[key] : props[kebab(String(key))] || "",
    set: (target, key, value) => { props[kebab(String(key))] = String(value); return true; },
  });
}
function selects(node, selector) {
  return selector.split(",").map(s => s.trim()).some(one =>
    one === "*" || (one.startsWith(".") ? node.classes.has(one.slice(1)) : node.tagName === one.toUpperCase()));
}
const DOC = { body: null, documentElement: { clientWidth: 1376, clientHeight: 904 } };
function element(tag = "div", cls = "") {
  const node = {
    tagName: tag.toUpperCase(), classes: new Set(cls.split(/\s+/).filter(Boolean)),
    style: inline(), dataset: {}, attrs: {}, children: [], parentElement: null,
    layout: null, scale: 1, border: 0, overflow: "visible", position: "static",
    offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollLeft: 0, value: "", textContent: "",
    font: 0, line: 21, padLeft: 0, padTop: 0, radius: 0, fill: "",
    animations: [],
    get className() { return [...node.classes].join(" "); },
    set className(value) { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
    classList: {
      add: (...names) => names.forEach(n => node.classes.add(n)),
      remove: (...names) => names.forEach(n => node.classes.delete(n)),
      contains: name => node.classes.has(name),
      toggle: (name, on) => ((on === undefined ? !node.classes.has(name) : on) ? node.classes.add(name) : node.classes.delete(name), node.classes.has(name)),
    },
    get isConnected() { let at = node; while (at.parentElement) at = at.parentElement; return at === DOC.body; },
    // the border box as drawn, in viewport px; the client box is the border box less
    // the border, in the box's own px (a box in a scaled stage measures smaller)
    getBoundingClientRect() {
      const r = node.layout || { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    },
    get clientLeft() { return node.border; },
    get clientTop() { return node.border; },
    get clientWidth() { return node.layout ? node.layout.width / node.scale - 2 * node.border : 0; },
    get clientHeight() { return node.layout ? node.layout.height / node.scale - 2 * node.border : 0; },
    setAttribute: (name, value) => { node.attrs[name] = String(value); },
    getAttribute: name => name in node.attrs ? node.attrs[name] : null,
    removeAttribute: name => { delete node.attrs[name]; },
    appendChild(child) { child.remove(); node.children.push(child); child.parentElement = node; return child; },
    append: (...kids) => kids.forEach(kid => node.appendChild(kid)),
    remove() {
      const parent = node.parentElement;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(node), 1);
      node.parentElement = null;
    },
    querySelectorAll(selector) {
      const out = [];
      const walk = at => at.children.forEach(kid => { if (selects(kid, selector)) out.push(kid); walk(kid); });
      walk(node);
      return out;
    },
    querySelector: selector => node.querySelectorAll(selector)[0] || null,
    cloneNode(deep) {
      const copy = element(tag, node.className);
      copy.textContent = node.textContent;
      if (deep) node.children.forEach(kid => copy.appendChild(kid.cloneNode(true)));
      return copy;
    },
    animate(keys, options) {
      const run = { keys, options, cancelled: false, playState: "running",
        cancel() { run.cancelled = true; run.playState = "idle"; } };
      node.animations.push(run);
      return run;
    },
  };
  return node;
}
function lay(node, r, scale = 1) {
  node.layout = r;
  node.scale = scale;
  node.offsetWidth = r.width / scale;
  node.offsetHeight = r.height / scale;
}
function context() {
  DOC.body = element("body");
  const frames = [];
  const ctx = vm.createContext({
    console,
    navigator: {},
    document: { body: DOC.body, documentElement: DOC.documentElement, createElement: tag => element(tag) },
    performance: { now: () => 0 },
    requestAnimationFrame: fn => frames.push(fn),
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
    getComputedStyle: node => ({
      visibility: "visible", display: "block", transform: "none", opacity: "1",
      overflowX: node.overflow, overflowY: node.overflow, position: node.position,
      fontSize: node.font ? node.font + "px" : "", lineHeight: node.line + "px",
      paddingLeft: node.padLeft + "px", paddingTop: node.padTop + "px",
      backgroundColor: node.fill || "rgba(0, 0, 0, 0)",
      borderTopLeftRadius: node.radius + "px", borderTopRightRadius: node.radius + "px",
      borderBottomRightRadius: node.radius + "px", borderBottomLeftRadius: node.radius + "px",
      getPropertyValue: name => name === "--card" ? "#ffffff" : name === "--bubble-fill" ? "#F3F3F3" : "",
    }),
  });
  vm.runInContext(LOGIC, ctx, { filename: "card-logic.js" });
  const frame = ms => { for (const fn of frames.splice(0)) fn(ms); };
  return { ctx, frame };
}

// ---- the Mac card, measured on the iPad in landscape (index.html) ----------------------
// main is the card pane, fixed and cut by its own overflow (index.html body.focus main);
// its .body cuts the foot under the head (body.focus .box.sel .body). TALL is a card
// laid out at the stage's default size, SHORT one laid out 240px tall, shorter than the
// typing row's cap (a quarter and more of the stage, index.html body.focus .box.sel textarea)
const CARD_LEFT = 466.5, CARD_WIDTH = 507;
const TALL = { mainTop: 116, mainBottom: 864, bodyTop: 204 };
const SHORT = { mainTop: 115.9, mainBottom: 355.9, bodyTop: 203.5 };
const ROW_CAP = 252;   // the row at its cap: a long message
function mac(card, rowHeight = ROW_CAP, scale = 1) {
  const { ctx, frame } = context();
  const stage = element("div");                                  // #stage, scaled as one piece
  DOC.body.appendChild(stage);
  const main = element("main");
  Object.assign(main, { overflow: "hidden", position: "fixed", border: 1 });
  lay(main, { left: CARD_LEFT, top: card.mainTop, width: CARD_WIDTH, height: card.mainBottom - card.mainTop }, scale);
  stage.appendChild(main);
  const box = element("article", "box sel");
  main.appendChild(box);
  const body = element("div", "body");
  body.overflow = "hidden";
  body.position = "relative";
  const bodyBottom = card.mainBottom - 1 - 20;                   // the card's foot pad under the row
  lay(body, { left: CARD_LEFT + 1, top: card.bodyTop, width: CARD_WIDTH - 2, height: bodyBottom - card.bodyTop }, scale);
  box.appendChild(body);
  const pendwrap = element("div", "pendwrap");
  pendwrap.position = "absolute";
  body.appendChild(pendwrap);
  const sentwrap = element("div", "sentwrap");
  pendwrap.appendChild(sentwrap);
  const ta = element("textarea");
  Object.assign(ta, { font: 17, line: 25.5, padLeft: 4, padTop: 8 });
  lay(ta, { left: 538, top: bodyBottom - rowHeight, width: 369.4, height: rowHeight }, scale);
  ta.value = "a long message";
  pendwrap.appendChild(ta);
  const el = { box, ta, sentwrap, sent: null };
  // the bubble the page draws for the send, laid out over the one-line row the send leaves
  const land = (top = bodyBottom - 44 - 26 - 84) => {
    const p = element("div", "answered sent");
    Object.assign(p, { radius: 18, fill: "rgb(249, 249, 249)" });
    const clip = element("div", "answclip"), stack = element("div", "answstack");
    const row = element("div", "answmsg cardmd");
    Object.assign(row, { font: 15, line: 20, padLeft: 0, padTop: 0 });
    stack.appendChild(row);
    clip.appendChild(stack);
    p.appendChild(clip);
    sentwrap.appendChild(p);
    el.sent = p;
    lay(p, { left: 563.6, top, width: 357, height: 84 }, scale);
    lay(row, { left: 581.6, top: top + 18, width: 321, height: 30 }, scale);
    lay(ta, { left: 538, top: bodyBottom - 44, width: 369.4, height: 44 }, scale);
    return p;
  };
  return { ctx, frame, el, main, body, ta, land, bodyBottom };
}
function fly(page) {
  const motion = page.ctx.armSentMotion(page.el);
  assert.ok(motion, "a long send on a laid-out row must fly");
  const shell = DOC.body.children.find(n => n.classes.has("sentmorph"));
  const cutAtArm = { ...pick(shell.style) };
  const p = page.land();
  motion.play();
  return { motion, shell, p, cutAtArm };
}
const pick = style => ({ left: style.left, top: style.top, width: style.width, height: style.height, overflow: style.overflow });
const px = v => parseFloat(v);
const cutOf = shell => ({ left: px(shell.style.left), top: px(shell.style.top),
  right: px(shell.style.left) + px(shell.style.width), bottom: px(shell.style.top) + px(shell.style.height) });
const near = (a, b, label, within = 1e-6) => assert.ok(Math.abs(a - b) <= within, `${label}: ${a} is not ${b}`);
// every ms of the flight, from its first frame drawn to the landing
const EVERY_MS = Array.from({ length: FLIGHT_MS + 1 }, (_, ms) => ms);

// ---- the cut ----------------------------------------------------------------------------
test("the cut is the boxes above the seat that clip, met, up to the first box fixed to the viewport", () => {
  const page = mac(SHORT);
  const view = page.ctx.sentView(page.el.sentwrap);
  // the .body's client box under the head, met with main's client box (inside its 1px border)
  near(view.left, CARD_LEFT + 1, "left");
  near(view.top, SHORT.bodyTop, "top");
  near(view.left + view.width, CARD_LEFT + CARD_WIDTH - 1, "right");
  near(view.top + view.height, page.bodyBottom, "bottom");
  // a box above the fixed card cuts nothing of it: the stage clipping its own box
  // is never met, nor is the body
  const stage = page.main.parentElement;
  stage.overflow = "hidden";
  lay(stage, { left: 0, top: 500, width: 10, height: 10 });
  DOC.body.overflow = "hidden";
  lay(DOC.body, { left: 0, top: 0, width: 1376, height: 41 });
  assert.deepEqual(page.ctx.sentView(page.el.sentwrap), view);
});

test("a box in the scaled stage cuts at its client box in viewport px", () => {
  const page = mac(SHORT, ROW_CAP, 0.5);
  page.body.overflow = "visible";   // the card pane alone cuts
  const view = page.ctx.sentView(page.el.sentwrap);
  // the pane's 1px border is a stage px, half a pixel on the screen
  near(view.left, CARD_LEFT + 0.5, "left");
  near(view.left + view.width, CARD_LEFT + CARD_WIDTH - 0.5, "right");
  near(view.top, SHORT.mainTop + 0.5, "top");
  near(view.top + view.height, SHORT.mainBottom - 0.5, "bottom");
});

test("nothing above the seat clipping, as on the small card, writes no cut", () => {
  const page = mac(SHORT);
  page.main.overflow = "visible";
  page.body.overflow = "visible";
  assert.equal(page.ctx.sentView(page.el.sentwrap), null);
  const { shell } = fly(page);
  assert.equal(shell.style.overflow, "", "a flight with nothing to be cut by is cut");
  assert.equal(shell.style.width, "");
  assert.equal(shell.style.height, "");
  const view = shell.querySelector(".sentmorph-view");
  assert.ok(px(view.style.left || 0) === 0 && px(view.style.top || 0) === 0, "the frame moved off the viewport's origin");
});

test("a long send on a card shorter than the row's cap reaches past what the card shows, and the flight is cut there from before its first frame", () => {
  const page = mac(SHORT);
  const view = page.ctx.sentView(page.el.sentwrap);
  const { shell, cutAtArm } = fly(page);
  // what the uncut flight drew: the row's whole box, past the card's head and its top edge
  const first = drawn(shell, 0);
  assert.ok(first.top < SHORT.mainTop - 30, `the long row's box does not reach past the card's top edge (${first.top})`);
  assert.ok(first.bottom > view.top + view.height - 1, "the box does not start on the row");
  // the cut, written as the shell went in and again as the flight was handed over
  const want = { left: view.left + "px", top: view.top + "px", width: view.width + "px", height: view.height + "px", overflow: "hidden" };
  assert.deepEqual(cutAtArm, want, "the shell was not cut as it went in");
  assert.deepEqual(pick(shell.style), want, "the shell is not cut where the card shows its foot");
  // inside the cut the flight stands where it stood: the frame holds the viewport's origin
  const frame = shell.querySelector(".sentmorph-view");
  near(px(frame.style.left) + view.left, 0, "the frame's left");
  near(px(frame.style.top) + view.top, 0, "the frame's top");
  assert.equal(shell.children.length, 1);
  assert.equal(shell.children[0], frame);
  assert.ok(frame.children[0].classes.has("sentmorph-clip"), "the clips do not stand in the frame");
  // and what is drawn, the box met with the cut, is inside the card at every ms
  const cut = cutOf(shell);
  for (const ms of EVERY_MS) {
    const d = drawn(shell, ms);
    near(d.origin.x, 0, `the flight left the viewport's origin at ${ms}ms`);
    const seen = { top: Math.max(d.top, cut.top), bottom: Math.min(d.bottom, cut.bottom) };
    if (seen.bottom <= seen.top) continue;
    assert.ok(seen.top >= SHORT.bodyTop - 1e-6, `the flight stood over the card's head at ${ms}ms (${seen.top})`);
    assert.ok(seen.bottom <= page.bodyBottom + 1e-6, `the flight stood past the card's foot at ${ms}ms (${seen.bottom})`);
  }
});

test("the landing hands over what the card shows of the bubble, so the bubble the card cuts is not drawn whole for a frame", () => {
  const page = mac(SHORT);
  const { shell, p } = fly(page);
  const landed = drawn(shell, FLIGHT_MS), cut = cutOf(shell), bubble = p.getBoundingClientRect();
  assert.ok(bubble.top < SHORT.bodyTop, "this bubble is not one the card cuts");
  near(landed.top, bubble.top, "the landing's top", 0.5);
  near(Math.max(landed.top, cut.top), Math.max(bubble.top, SHORT.bodyTop), "what is seen of the landing", 0.5);
});

test("a card that shows the whole of its foot loses nothing of the flight to the cut", () => {
  const page = mac(TALL);
  const { shell } = fly(page);
  const cut = cutOf(shell);
  for (const ms of EVERY_MS) {
    const d = drawn(shell, ms), e = 1e-6;
    assert.ok(d.top >= cut.top - e && d.bottom <= cut.bottom + e && d.left >= cut.left - e && d.right <= cut.right + e,
      `the cut took some of the flight at ${ms}ms on a card that shows it all`);
  }
});

test("a seat that moves mid-flight takes the cut with it when the flight is handed over again", () => {
  const page = mac(TALL);
  const { shell, p } = fly(page);
  page.frame(16);
  const before = cutOf(shell);
  // the card's foot comes up 120px (a keyboard on the phone, a card resized), and the bubble with it
  for (const node of [page.main, page.body]) lay(node, { ...node.layout, height: node.layout.height - 120 });
  lay(p, { ...p.layout, top: p.layout.top - 120 });
  page.frame(120);
  const after = cutOf(shell);
  near(after.bottom, before.bottom - 120, "the cut's foot");
  near(after.top, before.top, "the cut's head");
});

// ---- what the pages give the cut to read ------------------------------------------------
test("each page cuts the seat's column where the card shows it, which is what the cut reads", () => {
  const css = file => readFileSync(path.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (text, selector) => {
    const at = text.indexOf(selector + "{");
    assert.ok(at >= 0, "no rule " + selector);
    return text.slice(at, text.indexOf("}", at));
  };
  const desk = css("index.html"), phone = css("m.html");
  assert.match(rule(desk, "body.focus main"), /overflow:hidden/);
  assert.match(rule(desk, "body.focus main"), /position:fixed/);
  assert.match(rule(desk, "body.focus .box.sel .body"), /overflow:hidden/);
  assert.match(rule(phone, "  main"), /overflow:hidden/);
  assert.match(rule(phone, ".liftclip"), /overflow:clip/);
  assert.match(rule(phone, ".body"), /overflow:clip/);
  // the small card's seat is cut by nothing, so its flight is not cut either
  assert.doesNotMatch(rule(desk, "#magic2 .mbox"), /overflow/);
  assert.match(rule(desk, "#magic2.filled"), /overflow:visible/);
});

test("the sheet's shell clips nothing by itself; the script writes the cut, and the frame inside it is placed, not given a layer", () => {
  const sheet = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = selector => { const at = sheet.indexOf(selector + "{"); return sheet.slice(at, sheet.indexOf("}", at)); };
  assert.doesNotMatch(rule(".sentmorph"), /overflow/);
  assert.match(rule(".sentmorph-view"), /position:absolute; left:0; top:0/);
  assert.doesNotMatch(rule(".sentmorph-view"), /will-change|transform|overflow/);
  assert.doesNotMatch(sheet, /sentmorph[^{]*\{[^}]*(accent|432BFF)/i);
});
