// the right composer, with no browser. index.html's own right composer block,
// the card's send path, the frame's limits and the quick note's corner are
// lifted out of the page word for word and run over a small dom, beside the
// real card-logic.js and the real compose-format.js wearing its plain face (the
// setting off), so the draft crosses through the field's own public face
// exactly as it does on the board. the stand-in lays nothing out: a test writes
// the boxes a browser would report, and ends a run by firing the transition's
// end. how the page's turn and the bar's run look on screen is not claimed
// here; the sheet is read as text for the rules the design rests on. every
// card and every word below is invented
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const HTML = readFileSync(path.join(ROOT, "index.html"), "utf8");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const FORMAT = readFileSync(path.join(ROOT, "compose-format.js"), "utf8");

function between(source, start, end){
  const from = source.indexOf(start);
  assert.ok(from >= 0, "index.html no longer holds: " + start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, "index.html no longer holds: " + end);
  return source.slice(from, to);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// ---- the stand-in dom -------------------------------------------------------------
// elements with classes, children, attributes, listeners on a real prototype
// (compose-format.js reaches for Element.prototype), a textarea's value and
// selection, focus, and a height that is whatever the inline style pins or the
// layout would give (natural). gone says a rule of the sheet has put the node
// out of the layout, which is how display:none is stood in for
function makeDom(){
  const doc = { listeners: {}, activeElement: null };
  const win = { listeners: {} };
  const frames = new Map();
  let frameId = 0;
  function fire(target, type, props = {}){
    const ev = props.__event || { type, target, defaultPrevented: false, stopped: false,
      preventDefault(){ this.defaultPrevented = true; },
      stopPropagation(){ this.stopped = true; }, ...props };
    ev.target = ev.target || target;
    for (let node = target; node && !ev.stopped; node = node.parentNode)
      for (const fn of [...((node.listeners && node.listeners[type]) || [])]) fn.call(node, ev);
    for (const holder of [doc, win]){
      if (ev.stopped) break;
      for (const fn of [...(holder.listeners[type] || [])]) fn(ev);
    }
    return ev;
  }
  class Event {
    constructor(type, init = {}){
      this.type = type; this.bubbles = !!init.bubbles; this.defaultPrevented = false; this.stopped = false;
    }
    preventDefault(){ this.defaultPrevented = true; }
    stopPropagation(){ this.stopped = true; }
  }
  // every height pinned inline is kept in order; taking the pin off is not one
  function styleOf(){
    const props = {};
    const style = {
      heights: [],
      setProperty(k, v){ props[k] = String(v); },
      getPropertyValue(k){ return props[k] || ""; },
      removeProperty(k){ delete props[k]; },
    };
    Object.defineProperty(style, "height", {
      enumerable: true,
      get: () => props.height || "",
      set: v => { props.height = v == null ? "" : String(v); if (props.height) style.heights.push(props.height); },
    });
    return style;
  }
  // a tag, an id, classes, or a bare attribute, and a list of those
  function matches(node, sel){
    if (!node || !node.tagName) return false;
    return sel.split(",").some(one => {
      const attr = /^\[([\w-]+)\]$/.exec(one.trim());
      if (attr) return attr[1] in node.attributes;
      const m = /^([a-z0-9]*)(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(one.trim());
      if (!m || !one.trim()) return false;
      if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
      if (m[2] && node.id !== m[2].slice(1)) return false;
      for (const c of (m[3] || "").split(".").filter(Boolean)) if (!node.classes.has(c)) return false;
      return true;
    });
  }
  const all = node => node.children.flatMap(c => [c, ...all(c)]);
  class Element {
    constructor(tag){
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.listeners = {}; this.attributes = {};
      this.dataset = {}; this.style = styleOf(); this.hidden = false; this.own = ""; this.id = "";
      this.classes = new Set(); this.classLog = []; this.rect = null; this.natural = 0;
      this.gone = () => false;
      this._value = ""; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = "none";
      this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.files = [];
    }
    addEventListener(type, fn){ (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn){ this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    dispatchEvent(ev){ fire(this, ev.type, { __event: ev }); return !ev.defaultPrevented; }
    get className(){ return [...this.classes].join(" "); }
    set className(v){ this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList(){
      const set = this.classes, log = this.classLog;
      return {
        add: (...c) => c.forEach(x => { set.add(x); log.push("+" + x); }),
        remove: (...c) => c.forEach(x => { if (set.delete(x)) log.push("-" + x); }),
        contains: c => set.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !set.has(c) : !!force;
          if (on && !set.has(c)){ set.add(c); log.push("+" + c); }
          if (!on && set.delete(c)) log.push("-" + c);
          return on;
        },
      };
    }
    get value(){ return this._value; }
    set value(v){
      this._value = v == null ? "" : String(v);
      this.selectionStart = this.selectionEnd = this._value.length;
      this.selectionDirection = "none";
    }
    setSelectionRange(a, b, dir){
      const n = this._value.length;
      const start = Math.max(0, Math.min(a, n)), end = Math.max(0, Math.min(b == null ? a : b, n));
      this.selectionStart = Math.min(start, end); this.selectionEnd = end;
      this.selectionDirection = dir || "forward";
    }
    get textContent(){ return this.own + this.children.map(c => c.textContent).join(""); }
    set textContent(v){ for (const c of this.children) c.parentNode = null; this.children = []; this.own = v == null ? "" : String(v); }
    set innerHTML(v){ this.textContent = ""; this.markup = String(v); }
    get innerHTML(){ return this.markup || ""; }
    get parentElement(){ return this.parentNode; }
    appendChild(child){
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child);
      child.parentNode = this; this.children.push(child); return child;
    }
    append(...nodes){ for (const n of nodes) this.appendChild(n); }
    insertBefore(child, ref){
      this.appendChild(child);
      this.children.pop();
      const at = this.children.indexOf(ref);
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
      return child;
    }
    remove(){ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
    contains(node){ for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    closest(sel){ for (let n = this; n && n.tagName; n = n.parentNode) if (matches(n, sel)) return n; return null; }
    querySelector(sel){ return all(this).find(n => matches(n, sel)) || null; }
    querySelectorAll(sel){ return all(this).filter(n => matches(n, sel)); }
    get isConnected(){ let n = this; while (n.parentNode) n = n.parentNode; return n === doc.body; }
    setAttribute(k, v){ this.attributes[k] = String(v); }
    getAttribute(k){ return k in this.attributes ? this.attributes[k] : null; }
    removeAttribute(k){ delete this.attributes[k]; }
    // out of the layout if it or anything over it is put out by the sheet
    outOfLayout(){ for (let n = this; n; n = n.parentNode) if (n.gone && n.gone()) return true; return false; }
    get offsetParent(){ return this.outOfLayout() ? null : (this.parentNode || doc.body); }
    get offsetHeight(){
      if (this.outOfLayout()) return 0;
      const pinned = parseFloat(this.style.height);
      return Number.isFinite(pinned) ? pinned : this.natural;
    }
    get offsetWidth(){ return 0; }
    getBoundingClientRect(){
      if (this.rect) return { ...this.rect, x: this.rect.left, y: this.rect.top,
        width: this.rect.right - this.rect.left, height: this.rect.bottom - this.rect.top };
      const hgt = this.offsetHeight;
      return { left: 0, top: 0, right: 0, bottom: hgt, x: 0, y: 0, width: 0, height: hgt };
    }
    animate(){ return { finished: Promise.resolve() }; }
    focus(){ if (doc.activeElement === this) return; doc.activeElement = this; fire(this, "focusin"); }
    blur(){ if (doc.activeElement === this) doc.activeElement = doc.body; }
    click(){ fire(this, "click"); }
  }
  doc.createElement = tag => new Element(tag);
  doc.body = new Element("body");
  doc.activeElement = doc.body;
  doc.documentElement = { clientWidth: 1440, clientHeight: 900 };
  doc.addEventListener = (type, fn) => (doc.listeners[type] = doc.listeners[type] || []).push(fn);
  doc.getElementById = id => all(doc.body).find(n => n.id === id) || null;
  doc.querySelector = sel => doc.body.querySelector(sel);
  doc.querySelectorAll = sel => doc.body.querySelectorAll(sel);
  doc.createTreeWalker = () => ({ nextNode: () => null });
  const raf = fn => { frames.set(++frameId, fn); return frameId; };
  const caf = id => frames.delete(id);
  // run the frames that are waiting, once each, the way one frame would
  const frame = () => { const due = [...frames.values()]; frames.clear(); for (const fn of due) fn(); };
  return { doc, win, fire, Element, Event, raf, caf, frame, frames };
}

function storage(map = new Map()){
  return { map, getItem: k => (map.has(k) ? map.get(k) : null),
           setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

// ---- the page, as far as the composers reach ---------------------------------------
// the frame's limits, the card's send path and the right composer, each lifted
// out of index.html as it stands, over a few of the board's own names; the
// quick note's corner too when a test asks for it
const FRAME = HTML.match(/^const FRAME_CLEAR = \d+;.*$/m);
const LIMITS = between(HTML, "function frameLimits(){", "\n}\n") + "\n}\n";
const SEND = between(HTML, "// Enter and the card's send arrow each send", "// ---- older replies");
const RIGHT = between(HTML, "// ---- the right composer ----", "// the copy button on fenced blocks");
const NOTE = between(HTML, "// ---- the quick note ----", "\nrenameMagicLayouts();");
const KEYS = HTML.match(/^function boardKeysLive\(\)\{.*\}$/m);

const PRELUDE = `
let FOCUS = true, respMode = "wide", stageScale = 1, selectedId = null, lastState = null;
let activeOwner = "tools", dragging = null, sizing = null;
let qnOpen = false, editMode = false, pageWarn = null, pageMenu = null, p3Zoom = null;
const els = {};
const STAGE_W = 1440, STAGE_H = 900;
const PLUS_ICON = "<svg plus></svg>", SEND_ICON = "<svg send></svg>";
let snaps = 0, polls = 0, carets = 0;
function snapCard(){ snaps++; }
function poll(){ polls++; }
let queueFatCaret = () => { carets++; };
function onBoardPage(){ return true; }
function curWs(){ return null; }
function curView(){ return "todo"; }
function jumpNextYellow(){}
function boxDone(){ return false; }
function histExit(){}
function pendRow(text){ return h("div", "pendmsg", text); }
function stampRcpts(){}
function stampRun(){}
function pendBottom(){}
function growPend(el){
  const pend = h("div", "pendlist");
  pend.append(h("div", "pendslide"), h("div", "pendstamp"));
  el.pend = pend;
  return pend;
}
`;

// a whole page: the dom, the window the page sees, the stage with the card on
// it where the default layout puts it, the frame, and the blocks above
function openPage(opts = {}){
  const dom = makeDom();
  const store = opts.store || storage();
  store.setItem("composeformat", "0");   // the plain face: the setting off
  const media = { reduce: !!opts.reduce };
  const calls = [];
  const uploads = [];
  const answers = opts.answers || {};
  const win = opts.window || { w: 1440, h: 900 };
  // a resize watch that hears what the test says has changed size
  const watches = [];
  class ResizeObserver {
    constructor(fn){ this.fn = fn; this.els = new Set(); watches.push(this); }
    observe(el){ this.els.add(el); }
    unobserve(el){ this.els.delete(el); }
    disconnect(){ this.els.clear(); }
  }
  const resized = el => { for (const w of watches) if (w.els.has(el)) w.fn([{ target: el }]); };
  const sandbox = {
    ResizeObserver,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: dom.doc, localStorage: store, navigator: {}, location: {},
    Element: dom.Element, Event: dom.Event, NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: win.w, innerHeight: win.h,
    requestAnimationFrame: dom.raf, cancelAnimationFrame: dom.caf,
    matchMedia: q => ({ matches: media.reduce && /prefers-reduced-motion:\s*reduce/.test(q) }),
    // the card's own measures where the page asks for them: its 19.8px foot
    // padding (0.022 of 900), its 0.8px edge, and the row's 44px floor
    getComputedStyle: () => ({ lineHeight: "25.5px", paddingTop: "8px", paddingBottom: "19.8px",
      borderLeftWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "0.8px",
      display: "block", marginBottom: "0px",
      getPropertyValue: name => (name === "--row-min" ? "44px" : "") }),
    addEventListener: (type, fn) => (dom.win.listeners[type] = dom.win.listeners[type] || []).push(fn),
    CardMarkdown: { ATTACHMENT_ACCEPT: "image/*", attachmentFile: file => ({ name: file.name }),
                    render: t => String(t) },
    fetch: (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("/upload")){
        // an upload waits until the test lets it land
        let land;
        const answer = new Promise(resolve => { land = name => resolve({ ok: true,
          json: async () => ({ url: "/uploads/" + name }) }); });
        uploads.push({ url, land });
        return answer;
      }
      const ok = answers[url.split("?")[0]] !== false;
      return Promise.resolve({ ok, status: ok ? 200 : 500,
        json: async () => ({ ok: true, notes: [], note: { id: "qn1", text: "", card: null } }) });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  vm.runInContext(FORMAT, sandbox, { filename: "compose-format.js" });
  // the stage, the card and the frame, placed as a browser would report them
  const { doc } = dom;
  const stage = doc.createElement("div"); stage.id = "stage";
  const main = doc.createElement("main");
  const frame = doc.createElement("div"); frame.id = "appframe";
  doc.body.append(stage, frame);
  stage.appendChild(main);
  const layout = opts.layout || {
    stage: { left: 0, top: 41, right: 1440, bottom: 941 },
    // the card at its drawn place: x 0.324 and 0.368 of 1440, y 0.0704 and 0.8064 of 900
    card: { left: 466.56, right: 996.48, top: 41 + 63.36, bottom: 41 + 789.12 },
    frame: { left: 6, right: win.w - 6, top: 46, bottom: win.h - 6 },
  };
  stage.rect = layout.stage; main.rect = layout.card; frame.rect = layout.frame;
  vm.runInContext([
    PRELUDE,
    FRAME[0], LIMITS, SEND,
    opts.note ? KEYS[0] : "",
    RIGHT,
    opts.note ? NOTE : "",
    "globalThis.page = { els, xc, xcSwitch, switchComposer, xcSync, xcPlace,",
    opts.note ? "  quickNote, qnPeek," : "",
    "  get xcRoom(){ return xcRoom; }, get snaps(){ return snaps; }, get polls(){ return polls; },",
    "  set selectedId(v){ selectedId = v; }, set respMode(v){ respMode = v; },",
    "  set stageScale(v){ stageScale = v; } };",
  ].join("\n"), sandbox, { filename: "index.html#right-composer" });
  const page = sandbox.page;
  return { dom, sandbox, page, store, media, calls, uploads, stage, main, frame, watches, resized,
           scale: opts.scale || 1,
           // the first fit, which is where the board seats the box
           fit(){ page.xcPlace(); } };
}

// a card with its bar, built the way makeBox builds it: the field attached to
// the formatter first, then the row's own autosize, the input that ticks and
// carries, and enter. the page's makeBox is read below to hold it to this
function addCard(p, id, opts = {}){
  const { dom, sandbox, page } = p;
  const { doc } = dom;
  const el = tag => doc.createElement(tag);
  const box = el("article"); box.className = "box" + (opts.selected === false ? "" : " sel"); box.id = "box-" + id;
  const body = el("div"); body.className = "body";
  const replyview = el("div"); replyview.className = "replyview";
  replyview.scrollHeight = 2000; replyview.clientHeight = 600;
  const pendwrap = el("div"); pendwrap.className = "pendwrap";
  const meta = el("div"); meta.className = "meta";
  const metaNote = el("span");
  meta.appendChild(metaNote);
  const bottombar = el("div"); bottombar.className = "bottombar";
  // one line at rest: the row's 44px floor under its 0.8px hairline
  bottombar.natural = 44.8;
  // the sheet's own rule: body.focus .box.sel.xcaway .bottombar{display:none}
  bottombar.gone = () => box.classes.has("xcaway");
  // where a browser would report the bar: pinned to the floor of the card's
  // body, which stands the card's 19.8px foot padding and its 0.8px edge over
  // the card's bottom edge, lifted by anything laid under it in the wrapper,
  // and as tall as it is, all at the stage's scale
  bottombar.lift = 0;
  bottombar.getBoundingClientRect = () => {
    const c = p.main.rect, S = p.scale, hgt = bottombar.offsetHeight * S;
    const bottom = c.bottom - (19.8 + 0.8 + bottombar.lift) * S;
    return { left: c.left + 38.4 * S, right: c.right - 38.4 * S, top: bottom - hgt, bottom,
             x: c.left + 38.4 * S, y: bottom - hgt, width: c.right - c.left - 76.8 * S, height: hgt };
  };
  const clip = el("button"); clip.className = "clipbtn";
  const compose = el("div"); compose.className = "compose";
  const ta = el("textarea"); ta.clientHeight = 44;
  const send = el("button"); send.className = "sendbtn";
  compose.append(ta, send);
  bottombar.append(clip, compose);
  pendwrap.append(meta, bottombar);
  body.append(replyview, pendwrap);
  box.appendChild(body);
  p.main.appendChild(box);
  const field = sandbox.ComposeFormat.attach(ta, { newline: e => e.shiftKey });
  const tick = () => {
    if (!ta.offsetParent || !ta.clientHeight) return;
    send.classList.toggle("show", ta.value.trim().length > 0 || sandbox.arrowAgainFor(id));
  };
  ta.addEventListener("input", () => { sandbox.cancelAutoNext(); tick(); sandbox.xcCarry(id); });
  ta.addEventListener("keydown", e => sandbox.composerEnter(e, id));
  page.els[id] = { box, replyview, meta, metaNote, pend: null, pendRaw: "", ta, send, tick, field,
                   pendwrap, bottombar, clip, bar: { ta, send, tick } };
  return page.els[id];
}
// the page picks a card: the class, then the sync the page's select() makes
function choose(p, id){
  for (const [k, el] of Object.entries(p.page.els)) el.box.classList.toggle("sel", k === id);
  p.page.selectedId = id;
  p.page.xcSync();
}
const enter = (p, target, more = {}) => p.dom.fire(target, "keydown",
  { key: "Enter", shiftKey: false, isComposing: false, repeat: false, ...more });
const sends = p => p.calls.filter(c => c.url.startsWith("/send"));
// the transition the bar runs, landed the way the browser lands it
const landRun = el => el.bottombar.dispatchEvent({ type: "transitionend", propertyName: "height",
  target: el.bottombar, preventDefault(){}, stopPropagation(){} });
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, what + ": " + a + " is not " + b);
// the switch's box in the window, from where the page seated it on the stage
function switchRect(p, S = 1){
  const st = p.page.xcSwitch.style, sr = p.stage.rect;
  const left = sr.left + parseFloat(st.left) * S;
  const bottom = sr.top + (900 - parseFloat(st.bottom)) * S;
  return { left, right: left + parseFloat(st.width) * S,
           top: bottom - parseFloat(st.height) * S, bottom };
}

// ---- the sheet, read as text -------------------------------------------------------
const rule = selector => {
  const at = HTML.indexOf(selector + "{");
  assert.ok(at >= 0, "index.html no longer holds the rule: " + selector);
  return HTML.slice(at + selector.length + 1, HTML.indexOf("}", at));
};

// ---- the tests -----------------------------------------------------------------------

test("the switch opens the box on the right and puts it away, and a reload keeps the choice", async () => {
  const p = openPage();
  p.fit();
  addCard(p, "m31");
  choose(p, "m31");
  const { page } = p;
  const sw = page.xcSwitch, root = page.xc.root;
  assert.equal(sw.parentNode, p.stage, "the switch does not stand on the stage with the card");
  assert.equal(root.parentNode, p.stage, "the box does not stand on the stage");
  assert.equal(page.xcRoom, true, "the default card left no room right of it");
  assert.equal(sw.hidden, false);
  assert.equal(sw.getAttribute("aria-pressed"), "false");
  assert.equal(root.classes.has("open"), false, "the box was out before it was asked for");
  // the press
  p.dom.fire(sw, "click");
  assert.equal(p.store.getItem("composer.right"), "1", "the choice was not kept");
  assert.equal(sw.getAttribute("aria-pressed"), "true");
  assert.equal(root.classes.has("open"), true, "the box did not open");
  assert.equal(root.getAttribute("aria-hidden"), "false");
  assert.equal(page.xc.host, "m31");
  // the same page read again with the same store: it opens on the box at once
  const q = openPage({ store: p.store });
  q.fit();
  const card = addCard(q, "m31");
  choose(q, "m31");
  assert.equal(q.page.xc.root.classes.has("open"), true, "a reload lost the choice");
  assert.equal(q.page.xc.host, "m31");
  assert.equal(q.page.xcSwitch.getAttribute("aria-pressed"), "true");
  assert.ok(q.page.xc.root.classLog.includes("+still"), "a reload turned the page in instead of standing it there");
  assert.equal(card.box.classes.has("xcaway"), true, "a reload left the bar under the answer");
  assert.deepEqual(card.bottombar.style.heights, [], "a reload ran the bar");
  // and the press again puts it away and forgets the choice
  p.dom.fire(sw, "click");
  assert.equal(p.store.getItem("composer.right"), null);
  assert.equal(root.classes.has("open"), false, "the box stayed out");
  assert.equal(page.xc.host, null);
  assert.equal(sw.getAttribute("aria-pressed"), "false");
});

test("switchComposer is the one call a key can make, and names either side", async () => {
  const p = openPage();
  p.fit();
  addCard(p, "m32");
  choose(p, "m32");
  assert.equal(p.page.switchComposer("right"), true);
  assert.equal(p.page.switchComposer("right"), true, "asking for the side already chosen moved something");
  assert.equal(p.page.xc.host, "m32");
  assert.equal(p.page.switchComposer(), false, "with no side named it did not flip back");
  assert.equal(p.page.xc.host, null);
  assert.equal(p.page.switchComposer("bar"), false);
  // no key is bound for it yet: the shared key table does not name it, and the
  // switch's own press is the one place the page calls it
  assert.doesNotMatch(LOGIC, /switchComposer/, "a key already calls it");
  const calls = HTML.split("\n").filter(line => /switchComposer\(/.test(line) &&
    !/^\s*\/\//.test(line) && !/function switchComposer\(/.test(line));
  assert.deepEqual(calls.map(s => s.trim()),
    ['xcSwitch.addEventListener("click", () => { if (xcRoom) switchComposer(); });'],
    "switchComposer is called from somewhere besides the switch");
});

test("the draft crosses both ways: words, caret, a pick and the markdown the formatting is drawn from", async () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m33");
  choose(p, "m33");
  const words = "Ship the **fold** first\n- then the _rest_\n> and ~~not~~ this";
  card.ta.value = words;
  card.ta.setSelectionRange(11, 15, "forward");   // "fold" picked out
  card.ta.focus();
  p.page.switchComposer("right");
  const xta = p.page.xc.ta;
  assert.equal(xta.value, words, "the words did not cross");
  assert.equal(xta.value.slice(xta.selectionStart, xta.selectionEnd), "fold", "the pick did not cross");
  assert.equal(card.bar.ta.value, "", "the words were copied, not moved");
  assert.equal(card.ta, xta, "the card's row is still the bar");
  assert.equal(card.send, p.page.xc.send);
  assert.equal(p.dom.doc.activeElement, xta, "the caret did not follow the words");
  // more typed in the box, and back
  xta.value = words + "\nand one more line";
  xta.setSelectionRange(4, 4);
  p.page.switchComposer("bar");
  assert.equal(card.bar.ta.value, words + "\nand one more line", "the words did not come home");
  assert.deepEqual([card.bar.ta.selectionStart, card.bar.ta.selectionEnd], [4, 4], "the caret did not come home");
  assert.equal(xta.value, "", "the box kept a copy");
  assert.equal(card.ta, card.bar.ta, "the card's row is still the box");
  assert.equal(card.send, card.bar.send);
  assert.equal(card.tick, card.bar.tick);
  assert.equal(p.dom.doc.activeElement, card.bar.ta, "the caret did not come home with the words");
  // the page moves them through the field's face: nothing reaches into the dom
  assert.doesNotMatch(RIGHT, /innerHTML\s*=(?!\s*(?:PLUS_ICON|SEND_ICON);)|\.cm-content|contentDOM|\.view\b|textContent\s*=/,
    "the right composer reaches past the field's public face");
});

test("the box follows the selection: each card's draft goes home and the next card's comes in", async () => {
  const p = openPage();
  p.fit();
  const a = addCard(p, "m34"), b = addCard(p, "m35", { selected: false });
  a.ta.value = "words for the first card";
  b.ta.value = "words for the second";
  choose(p, "m34");
  p.page.switchComposer("right");
  p.page.xc.ta.value = "words for the first card, edited in the box";
  choose(p, "m35");
  assert.equal(a.bar.ta.value, "words for the first card, edited in the box", "the first card's draft was lost");
  assert.equal(a.ta, a.bar.ta);
  assert.equal(a.box.classes.has("xcaway"), false, "the card left behind kept its bar away");
  assert.equal(p.page.xc.ta.value, "words for the second", "the second card's draft did not come in");
  assert.equal(b.bar.ta.value, "");
  assert.equal(b.ta, p.page.xc.ta);
  assert.equal(b.box.classes.has("xcaway"), true);
  assert.equal(p.page.xc.root.classes.has("open"), true, "the box went away on a card switch");
  assert.deepEqual(b.bottombar.style.heights, [], "a card switch ran the bar");
  // no card at all: the draft goes home and the box goes
  for (const el of Object.values(p.page.els)) el.box.classList.remove("sel");
  p.page.selectedId = null;
  p.page.xcSync();
  assert.equal(b.bar.ta.value, "words for the second");
  assert.equal(p.page.xc.root.classes.has("open"), false);
  // the page's own selection paths make the same call
  assert.match(between(HTML, "function select(id, opts){", "\n}\n"),
    /classList\.toggle\("t-sel", k === id\);\s*\}[\s\S]*?xcSync\(\);[\s\S]*?els\[id\]\.tick\(\)[\s\S]*?els\[id\]\.ta\.focus/,
    "select() does not move the draft before it ticks and focuses the card's row");
  assert.match(between(HTML, "function applySelection(state){", "\n}\n"), /xcSync\(\);/);
  assert.match(between(HTML, "function deselect(){", "\n}\n"), /xcSync\(\);/);
  assert.match(between(HTML, "function apply(state){", "els[id].box.remove()"),
    /if \(xc\.host === id\) xcGive\(false\);\s*[\s\S]*?els\[id\]\.field\?\.detach\(\);/,
    "a card leaving the board is not let go of first");
});

test("an attachment still uploading crosses too, and always lands on the card it was picked for", async () => {
  const p = openPage();
  p.fit();
  const a = addCard(p, "m36"), b = addCard(p, "m37", { selected: false });
  choose(p, "m36");
  a.ta.value = "see the picture";
  // picked in the bar, and the reader switches before it lands
  const fromBar = p.sandbox.attach([{ name: "bar.png" }], a.ta);
  p.page.switchComposer("right");
  p.uploads.shift().land("bar.png");
  await fromBar;
  assert.equal(p.page.xc.ta.value, "see the picture\n/uploads/bar.png\n", "the upload did not follow the draft into the box");
  assert.equal(a.bar.ta.value, "", "the upload stayed behind in the bar");
  // picked with the box's own plus, and the reader goes back before it lands
  p.page.xc.clipfile.files = [{ name: "box.png" }];
  p.dom.fire(p.page.xc.clip, "click");   // the plus hands the press to the picker
  p.dom.fire(p.page.xc.clipfile, "change");
  assert.equal(p.uploads.length, 1, "the box's plus did not go up the board's /upload road");
  assert.match(p.uploads[0].url, /^\/upload\?name=box\.png$/);
  p.page.switchComposer("bar");
  p.uploads.shift().land("box.png");
  await settle();
  assert.equal(a.bar.ta.value, "see the picture\n/uploads/bar.png\n/uploads/box.png\n",
    "the box's upload did not land in the bar the draft went home to");
  // picked in the box for one card while the reader moves to another
  p.page.switchComposer("right");
  p.dom.fire(p.page.xc.ta, "paste", { clipboardData: { files: [{ name: "drop.png" }] } });
  b.ta.value = "the other card";
  choose(p, "m37");
  p.uploads.shift().land("drop.png");
  await settle();
  assert.match(a.bar.ta.value, /\/uploads\/drop\.png\n$/, "the picture left the card it was picked for");
  assert.equal(p.page.xc.ta.value, "the other card", "the picture landed on the wrong card");
  // the card's own input carries it, as makeBox wires it
  assert.match(between(HTML, "function makeBox(b, i, state){", "\n}\n"),
    /ta\.addEventListener\("input", \(\) => \{\s*cancelAutoNext\(\);\s*tick\(\);[\s\S]*?xcCarry\(b\.id\);\s*\}\);/,
    "makeBox no longer carries a late upload");
  assert.match(HTML, /bar: \{ ta, send, tick \} \};/, "makeBox no longer keeps the bar's own row");
});

test("a send from the box is a send from the bar: same enter, same arrow, same road", async () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m38");
  choose(p, "m38");
  // from the bar first
  card.ta.value = "from the bar";
  const barEnter = enter(p, card.ta);
  assert.equal(barEnter.defaultPrevented, true);
  await settle();
  // then from the box, by enter and by the arrow
  p.page.switchComposer("right");
  const xta = p.page.xc.ta;
  xta.value = "from the box";
  const boxEnter = enter(p, xta);
  assert.equal(boxEnter.defaultPrevented, true, "enter in the box broke the line instead of sending");
  assert.equal(xta.value, "", "the box did not clear on send");
  await settle();
  await new Promise(resolve => setTimeout(resolve, 760));   // past the second press's window
  xta.value = "by the arrow";
  p.page.xcSync();
  p.dom.fire(p.page.xc.send, "click");
  await settle();
  // shift enter is a new line in both
  xta.value = "a line";
  const shifted = enter(p, xta, { shiftKey: true });
  assert.equal(shifted.defaultPrevented, false, "shift enter sent from the box");
  const sent = sends(p);
  assert.deepEqual(sent.map(c => c.url), ["/send?box=m38", "/send?box=m38", "/send?box=m38"]);
  assert.deepEqual(sent.map(c => c.init.body), ["from the bar", "from the box", "by the arrow"]);
  assert.ok(sent.every(c => c.init.method === "POST"));
  assert.equal(card.pendRaw, "from the bar\n\nfrom the box\n\nby the arrow", "the sent box did not take all three");
});

test("a send that fails from the box keeps its words in the box and frees the square", async () => {
  const p = openPage({ answers: { "/send": false } });
  p.fit();
  const card = addCard(p, "m39");
  choose(p, "m39");
  p.page.switchComposer("right");
  p.page.xc.ta.value = "keep me";
  enter(p, p.page.xc.ta);
  assert.equal(p.page.xc.send.disabled, true, "the square was free while the send was in the air");
  await settle(); await settle();
  assert.equal(p.page.xc.ta.value, "keep me", "a failed send lost the words");
  assert.equal(p.page.xc.send.disabled, false, "the square stayed held");
  assert.match(card.metaNote.textContent, /send failed/);
  // the square doSend holds is the one it disabled, whichever composer holds the draft by the time the board answers
  assert.match(between(HTML, "async function doSend(id, opts){", "\n}\n"),
    /const send = el\.send;[\s\S]*finally \{\s*send\.disabled = false;/);
});

test("the answer grows down on the bar's own eased run and shrinks back on it, the scroll held", async () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m40");
  choose(p, "m40");
  const bar = card.bottombar, view = card.replyview;
  card.ta.value = "a draft";
  view.scrollTop = 300;   // part way down a long answer
  p.page.switchComposer("right");
  // the bar is pinned at its height and run to nothing, with its run on
  assert.deepEqual(bar.style.heights, ["44.8px", "0px"], "the bar did not run from its height to nothing");
  assert.ok(bar.classes.has("xcrun") && bar.classes.has("xcclip"), "the bar jumped instead of running");
  assert.equal(card.box.classes.has("xcaway"), false, "the bar went before its run was over");
  assert.equal(p.page.snaps, 0);
  landRun(card);
  assert.equal(card.box.classes.has("xcaway"), true, "the bar did not leave once its run was over");
  assert.equal(bar.style.height, "", "the run left a height pinned");
  assert.ok(!bar.classes.has("xcrun") && !bar.classes.has("xcdim"));
  assert.equal(view.scrollTop, 300, "the answer's scroll moved");
  assert.equal(p.page.snaps, 1, "the answer was not snapped to its new room");
  // and back: up from nothing to the bar's own height, faded in on the same run
  p.page.switchComposer("bar");
  assert.equal(card.box.classes.has("xcaway"), false);
  assert.deepEqual(bar.style.heights.slice(-2), ["0px", "44.8px"], "the bar did not come back up from nothing");
  assert.ok(bar.classes.has("xcrun"));
  assert.ok(bar.classLog.slice(-4).includes("-xcdim"), "the bar did not fade back in");
  landRun(card);
  assert.equal(bar.style.height, "");
  assert.equal(view.scrollTop, 300, "the answer's scroll moved on the way back");
  // a reader at the very end of the answer rides with the floor on every frame
  view.scrollTop = 1400;   // 1400 + 600 is the whole 2000
  p.page.switchComposer("right");
  view.scrollHeight = 1960;   // the band coming off the padding, a frame in
  p.dom.frame();
  assert.equal(view.scrollTop, 1960, "the reader at the end was not held there");
  landRun(card);
  assert.equal(p.dom.frames.size, 0, "the hold outlived the run");
  // the sheet: the run is the bar's height and fade on the card's one curve,
  // and the bar is out of the layout once it is away
  assert.match(rule("  body.focus .box.sel .bottombar.xcrun"),
    /transition:height \.32s var\(--gentle\), opacity \.32s var\(--gentle\);/);
  assert.match(rule("  body.focus .box.sel.xcaway .bottombar"), /display:none/);
  assert.match(RIGHT, /const XC_RUN_MS = 320;/, "the safety net no longer matches the sheet's run");
});

test("a second press part way through turns the run round from where it stands", async () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m41");
  choose(p, "m41");
  p.page.switchComposer("right");
  const written = card.bottombar.style.heights.length;
  p.page.switchComposer("bar");
  // no fresh pin: the run in flight is simply handed the other end
  assert.deepEqual(card.bottombar.style.heights.slice(written), ["44.8px"], "the run started over");
  landRun(card);
  assert.equal(card.box.classes.has("xcaway"), false);
  assert.equal(card.bottombar.style.height, "");
});

test("reduced motion: the box stands in and the bar steps aside at once", async () => {
  const p = openPage({ reduce: true });
  p.fit();
  const card = addCard(p, "m42");
  choose(p, "m42");
  card.ta.value = "still words";
  p.page.switchComposer("right");
  assert.equal(card.box.classes.has("xcaway"), true, "the bar ran under reduced motion");
  assert.deepEqual(card.bottombar.style.heights, [], "a height was run under reduced motion");
  assert.ok(!card.bottombar.classLog.includes("+xcrun"));
  assert.ok(p.page.xc.root.classLog.includes("+still"), "the page turned under reduced motion");
  assert.equal(p.page.xc.ta.value, "still words");
  p.page.switchComposer("bar");
  assert.equal(card.box.classes.has("xcaway"), false);
  assert.deepEqual(card.bottombar.style.heights, []);
  assert.equal(card.bar.ta.value, "still words");
  // and the sheet takes every run away under reduced motion, the page's tilt too
  const quiet = HTML.slice(HTML.indexOf("  body:is([data-resp-mode=\"portrait\"], [data-resp-mode=\"twopane\"]) :is(#xcswitch, #xcomposer)"));
  const block = between(quiet, "@media (prefers-reduced-motion: reduce){", "\n  }\n");
  assert.match(block, /body\.focus #xcomposer, body\.focus #xcomposer \.xcpage,\s*body\.focus \.box\.sel \.bottombar\.xcrun\{transition:none\}/);
  assert.match(block, /body\.focus #xcomposer \.xcpage\{transform:none\}/);
});

test("the page's turn is transform and opacity only, quick, and flat at rest", () => {
  const page = rule("  body.focus #xcomposer .xcpage");
  const open = rule("  body.focus #xcomposer.open .xcpage");
  for (const r of [page, open]){
    const runs = /transition:([^;]+);/.exec(r)[1].split(",").map(s => s.trim());
    for (const run of runs){
      const [prop, dur, , delay] = run.split(/\s+/);
      assert.ok(["transform", "opacity"].includes(prop), "the turn runs " + prop);
      const total = parseFloat(dur) * 1000 + (delay ? parseFloat(delay) * 1000 : 0);
      assert.ok(total >= 200 && total <= 400, "a leg of the turn runs " + total + "ms");
    }
    assert.doesNotMatch(r, /filter|blur|mask|height/, "the turn animates something heavy");
  }
  assert.match(page, /transform-origin:0 50%; transform:rotateY\(-72deg\); opacity:0;/);
  assert.match(open, /transform:none; opacity:1;/, "the page keeps a transform at rest");
  assert.match(rule("  body.focus #xcomposer"), /perspective:1200px; perspective-origin:0 50%;/);
  assert.match(rule("  body.focus #xcomposer.still, body.focus #xcomposer.still .xcpage"), /transition:none/);
});

test("the box wears the card's own look: white, the edge, the 7px corner, the raised shadow, the bar's type", () => {
  const page = rule("  body.focus #xcomposer .xcpage");
  assert.match(page, /background:var\(--card\); border:var\(--edge\) solid var\(--line\); border-radius:7px;/);
  const cardShadow = /box-shadow:([^;]+);/.exec(rule("  body.focus main"))[1];
  assert.equal(/box-shadow:([^;]+);/.exec(page)[1], cardShadow, "the box's shadow is not the card's");
  assert.match(rule("  body.focus .box.sel textarea"), /font-size:17px; line-height:1\.5;/);
  assert.match(rule("  body.focus #xcomposer textarea"), /font:17px\/1\.5 var\(--sans\)/);
  assert.match(rule("  body.focus #xcomposer .cm-placeholder"), /color:#B4AA99/);
  assert.match(HTML, /textarea::placeholder\{color:#B4AA99\}/, "the board's placeholder ink moved");
  // the plus and the send square are the bar's own rules, listed beside them
  for (const sel of [".sendbtn{", ".sendbtn.show", ".clipbtn{", ".clipbtn::before", ".clipfile"])
    assert.ok(HTML.includes("body.focus .box.sel " + sel.replace("{", "") + ", body.focus #xcomposer " + sel.replace("{", "")),
      "the box does not wear the bar's " + sel);
  // the hint and the plus at its top, as sketched
  const p = openPage();
  assert.equal(p.page.xc.ta.placeholder, "Push to production …");
  const side = p.page.xc.page.children.find(n => n.classes.has("xcside"));
  assert.deepEqual(side.children.map(n => n.className), ["clipbtn", "sendbtn"], "the plus is not at the top of the side");
});

test("the box stands off the card inside the frame, on the stage's own pixels", () => {
  const p = openPage();
  p.fit();
  const st = p.page.xc.root.style;
  const cell = 1440 * 0.008;
  // two cells off the card's right edge at 996.48, 24 wide, its foot five cells over the card's floor at 789.12
  near(parseFloat(st.left), 996.48 + 2 * cell, "the box's left");
  near(parseFloat(st.width), 24 * cell, "the box's width");
  near(parseFloat(st.bottom), 900 - (789.12 - 5 * cell), "the box's foot");
  near(parseFloat(st.getPropertyValue("--xc-max")), 789.12 - 5 * cell - 63.36, "the box's growth to the card's top");
  // a board scaled down to fit: the same place in stage pixels
  const q = openPage({ window: { w: 1200, h: 760 }, layout: {
    stage: { left: 20, top: 41, right: 20 + 1440 * .8, bottom: 41 + 900 * .8 },
    card: { left: 20 + 466.56 * .8, right: 20 + 996.48 * .8, top: 41 + 63.36 * .8, bottom: 41 + 789.12 * .8 },
    frame: { left: 6, right: 1194, top: 46, bottom: 754 } } });
  q.page.stageScale = .8;
  q.fit();
  assert.ok(Math.abs(parseFloat(q.page.xc.root.style.left) - (996.48 + 2 * cell)) < 1e-6, "the box was not placed in stage pixels");
  assert.equal(q.page.xcRoom, true);
});

test("the owner's layout: the box fits beside the card, over the navigator, clear of the frame and the switch", () => {
  // read off the owner's screenshot of the facilitator tab (September 22, a
  // 1509 by 943 window): the card from 420 to 925 across and 123 to 847 down,
  // the file navigator filling the right from 973 to 1466. the scale and the
  // stage's origin are a fit of that window, estimated
  const S = .97, sx = 40, sy = 41;
  const p = openPage({ scale: S, window: { w: 1509, h: 943 }, layout: {
    stage: { left: sx, top: sy, right: sx + 1440 * S, bottom: sy + 900 * S },
    card: { left: 420, right: 925, top: 123, bottom: 847 },
    frame: { left: 6, right: 1503, top: 46, bottom: 937 } } });
  p.page.stageScale = S;
  p.fit();
  addCard(p, "m43");
  choose(p, "m43");
  p.page.switchComposer("right");
  assert.equal(p.page.xc.host, "m43", "the box found no room on the owner's board");
  const st = p.page.xc.root.style;
  const left = sx + parseFloat(st.left) * S, right = left + parseFloat(st.width) * S;
  const foot = sy + (900 - parseFloat(st.bottom)) * S;
  assert.ok(left > 925, "the box stands on the card");
  const lim = { right: 1503 - 1 - 16, bottom: 937 - 1 - 16 };
  assert.ok(right <= lim.right, "the box runs past the frame's clear edge");
  assert.ok(foot <= lim.bottom && foot < 847, "the box's foot is below the card's");
  // the switch stands on the card's edge beside the bar, where the bar rested
  // before the box took its words, a cell clear of the box and well clear of
  // the owner's navigator at 973
  const tab = switchRect(p, S);
  near(tab.left, 925 - 7 * S, "the switch's tuck under the card");
  near(tab.right, 925 + 1440 * 0.008 * S, "the switch's outer edge");
  near(tab.bottom, 847 - 20.6 * S, "the switch's foot is not the bar's floor");
  near(tab.bottom - tab.top, 44.8 * S, "the switch is not the bar's height");
  assert.ok(tab.right < left, "the switch runs into the box");
  assert.ok(tab.right < 973, "the switch reaches the owner's navigator");
  // the box stands over the boxes the owner keeps there, under the edit handles
  assert.match(rule("  body.focus #xcomposer"), /position:fixed; z-index:6;/);
  assert.match(HTML, /#edithandles\{[^}]*z-index:30/);
});

test("where the box cannot stand, the bar stays: two panes, the portrait column, a card with no room", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m44");
  choose(p, "m44");
  card.ta.value = "kept through every mode";
  p.page.switchComposer("right");
  assert.equal(p.page.xc.host, "m44");
  for (const mode of ["twopane", "portrait"]){
    p.page.respMode = mode;
    p.fit();
    assert.equal(p.page.xcRoom, false, mode + " left room for the box");
    assert.equal(p.page.xc.host, null, "the box kept the draft in " + mode);
    assert.equal(card.bar.ta.value, "kept through every mode", "the draft was lost going to " + mode);
    assert.equal(card.box.classes.has("xcaway"), false, "the bar is away in " + mode);
    assert.equal(p.page.xcSwitch.hidden, true, "the switch shows in " + mode);
    assert.equal(p.store.getItem("composer.right"), "1", "the choice was dropped in " + mode);
    assert.equal(p.page.switchComposer("right"), true, "asking again in " + mode + " changed the choice");
    assert.equal(p.page.xc.host, null, "the box opened in " + mode);
  }
  // back on the wide board the choice is kept and the box stands again, at once
  p.page.respMode = "wide";
  p.fit();
  assert.equal(p.page.xc.host, "m44");
  assert.equal(p.page.xc.ta.value, "kept through every mode");
  // a card dragged hard against the right: no room, the switch says so and takes no press
  p.main.rect = { left: 1000, right: 1300, top: 104, bottom: 830 };
  p.fit();
  assert.equal(p.page.xcRoom, false);
  assert.equal(p.page.xc.host, null);
  assert.equal(p.page.xcSwitch.getAttribute("aria-disabled"), "true");
  assert.match(p.page.xcSwitch.getAttribute("title"), /no room/);
  p.dom.fire(p.page.xcSwitch, "click");
  assert.equal(p.store.getItem("composer.right"), "1", "a press on the switch with no room changed the choice");
  // and the sheet takes both away in the two modes whatever the script says
  assert.match(HTML, /body:is\(\[data-resp-mode="portrait"\], \[data-resp-mode="twopane"\]\) :is\(#xcswitch, #xcomposer\)\{display:none !important\}/);
  // the board calls the seat every time it fits
  const fit = between(HTML, "function fitStage(){", "\n}\n");
  assert.equal((fit.match(/xcPlace\(\);/g) || []).length, 2, "fitStage does not seat the box on both of its ways out");
});

test("the switch stands on the card's right edge beside the compose bar, spanning it, and moves and scales with the card", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m47");
  choose(p, "m47");
  const cell = 1440 * 0.008;
  let tab = switchRect(p), bar = card.bottombar.getBoundingClientRect();
  // one cell out past the card's right edge at 996.48, and 7px in under it
  near(tab.left, 996.48 - 7, "the switch's tuck under the card");
  near(tab.right, 996.48 + cell, "the switch's outer edge");
  // its top on the bar's hairline and its foot on the bar's floor: the bar's
  // own 44.8 at rest, one line
  near(tab.top, bar.top, "the switch's top is not the bar's");
  near(tab.bottom, bar.bottom, "the switch's foot is not the bar's");
  near(tab.bottom - tab.top, 44.8, "the switch is not the bar's height");
  // not at the card's very bottom: the card's 19.8 foot padding and its 0.8
  // edge stand under it, as they stand under the bar
  near(p.main.rect.bottom - tab.bottom, 20.6, "the switch is not lifted off the card's bottom edge");
  // tall and narrow
  assert.ok(tab.bottom - tab.top > 3.5 * (tab.right - p.main.rect.right), "the switch is not a tall narrow tab");
  // the sheet: behind the card and every box, no edge where it meets the card,
  // and no place of its own in the window any more
  const sw = rule("  body.focus #xcswitch");
  assert.match(sw, /position:fixed; z-index:-1;/, "the switch does not stand behind the card");
  assert.match(sw, /border-left:none;/);
  assert.match(sw, /border-radius:0 var\(--sq\) var\(--sq\) 0;/);
  assert.doesNotMatch(sw, /(?:^|[\s;])(right|bottom|left|top|width|height):/, "the sheet still places the switch itself");
  assert.doesNotMatch(HTML, /bottom:84px/, "the old dodge of the note's corner is still in the sheet");
  // a drag of the card takes the switch with it, still beside the bar; the
  // card's own size watch is what hears it
  p.main.rect = { left: 300, right: 830, top: 80, bottom: 700 };
  p.resized(p.main);
  tab = switchRect(p); bar = card.bottombar.getBoundingClientRect();
  near(tab.left, 830 - 7, "the switch stayed behind when the card moved");
  near(tab.top, bar.top, "the switch left the bar when the card moved");
  near(tab.bottom, bar.bottom, "the switch left the bar's floor when the card moved");
  // a board scaled down: the same place on the stage, so it shrinks with the
  // card. before any card is on show it stands where a bar at rest would, read
  // off the card's own padding and the row's floor, and once the bar can be
  // read it is the same place
  const q = openPage({ scale: .8, window: { w: 1200, h: 760 }, layout: {
    stage: { left: 20, top: 41, right: 20 + 1440 * .8, bottom: 41 + 900 * .8 },
    card: { left: 20 + 466.56 * .8, right: 20 + 996.48 * .8, top: 41 + 63.36 * .8, bottom: 41 + 789.12 * .8 },
    frame: { left: 6, right: 1194, top: 46, bottom: 754 } } });
  q.page.stageScale = .8;
  q.fit();
  const qs = q.page.xcSwitch.style;
  near(parseFloat(qs.left), 996.48 - 7, "the switch was not placed in stage pixels");
  near(parseFloat(qs.bottom), 900 - 789.12 + 20.6, "the rest place is not the bar's floor");
  near(parseFloat(qs.height), 44.8, "the rest place is not the bar's height");
  addCard(q, "m52");
  choose(q, "m52");
  near(parseFloat(qs.bottom), 900 - 789.12 + 20.6, "the scaled bar's floor was not read in stage pixels");
  near(parseFloat(qs.height), 44.8, "the scaled bar's height was not read in stage pixels");
  assert.equal(q.page.xcSwitch.parentNode, q.stage, "the switch does not scale with the stage");
  // the large card alone carries it: the small cards' build never names it
  const mini = between(HTML, 'const compose = h("div", "mcompose");', "box.append(sun, arc, x, title, answwrap, reply, pend, compose);");
  assert.doesNotMatch(mini, /xcSwitch|switchComposer|xcswitch/, "the small cards carry the switch");
  assert.equal((HTML.match(/xcSwitch\.id = "xcswitch";/g) || []).length, 1, "there is more than one switch");
});

test("the switch tracks the bar: more lines, a note under it, the sent box and the answered panel above it, a card switch", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m50");
  choose(p, "m50");
  const lined = (what, el = card) => {
    const tab = switchRect(p), bar = el.bottombar.getBoundingClientRect();
    near(tab.top, bar.top, what + ": the switch's top is off the bar's hairline");
    near(tab.bottom, bar.bottom, what + ": the switch's foot is off the bar's floor");
  };
  lined("at rest");
  // the watch is on the bar and on the wrapper it stands in
  const watch = p.watches.find(w => w.els.has(card.bottombar));
  assert.ok(watch, "the bar is not watched");
  assert.ok(watch.els.has(card.pendwrap), "the wrapper the bar stands in is not watched");
  // four lines typed: the row grows, the bar with it, and the watch hears the
  // bar. the formatted editor grows the same bar, its scroller being the row,
  // and it is the bar that is watched whichever face the field wears
  card.bottombar.natural = 44.8 + 3 * 25.5;
  p.resized(card.bottombar);
  lined("four lines");
  near(switchRect(p).bottom - switchRect(p).top, 44.8 + 3 * 25.5, "the switch did not grow with the bar");
  // the sent box opening above the bar grows the wrapper and leaves the bar,
  // and so the switch, where they are
  const open = switchRect(p);
  p.resized(card.pendwrap);
  assert.deepEqual(switchRect(p), open, "the sent box moved the switch");
  // a note landing under the bar lifts it, and the switch goes up with it
  card.bottombar.lift = 30;
  p.resized(card.pendwrap);
  lined("a note under the bar");
  card.bottombar.lift = 0;
  p.resized(card.pendwrap);
  lined("the note gone");
  // the answered panel is in the answer's own scroller and moves nothing the
  // switch stands by: the next poll still finds it on the bar
  p.page.xcSync();
  lined("the answered panel opened");
  assert.ok(!watch.els.has(card.replyview), "the answer's scroller is watched for nothing");
  // back to one line
  card.bottombar.natural = 44.8;
  p.resized(card.bottombar);
  lined("one line again");
  // another card: the switch lines up with that card's bar and the watch moves over
  const other = addCard(p, "m51", { selected: false });
  other.bottombar.natural = 70.3;
  choose(p, "m51");
  lined("the next card", other);
  assert.ok(watch.els.has(other.bottombar) && !watch.els.has(card.bottombar), "the watch stayed on the last card's bar");
  // the page's own hooks: the seat is read before any move and after every run
  assert.match(between(HTML, "function xcSync(opts = {}){", "\n}\n"), /^\s*xcSeat\(\);/m);
  assert.match(between(HTML, "function xcLanded(el, end){", "\n}\n"), /xcSeat\(\);/);
});

test("the switch keeps off the card's own controls: the row, the send square and the answered panel's arrow", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m48");
  choose(p, "m48");
  const tab = switchRect(p), box = p.main.rect;
  // the part that shows stands wholly outside the card's box
  near(tab.left + 7, box.right, "the switch shows inside the card");
  // and nothing of the card can paint outside its own box to meet it: the card
  // clips what it holds, and every control named is held inside it
  assert.match(rule("  body.focus main"), /overflow:hidden;/, "the card no longer clips what it holds");
  for (const node of [card.ta, card.send, card.clip]) assert.ok(p.main.contains(node), "a control stands outside the card");
  assert.match(between(HTML, "function makeBox(b, i, state){", "\n}\n"),
    /replyview\.append\(answwrap, reply\);\s*body\.append\(replyview, pendwrap\);/,
    "the answered panel is no longer inside the card's body");
  // the tucked part is under the card, painted over by it, and stops well short
  // of the send square, which stands the card's side padding and the bar's own
  // margin in from the card's edge
  const padX = 1440 * 0.016;
  assert.match(rule("  body.focus main"), /padding:calc\(var\(--ch\)\*0\.022\) var\(--pad-x\);/);
  assert.match(rule("  body.focus .box.sel .bottombar"), /margin:0 calc\(var\(--pad-x\)\*2\/3\) 0 calc\(var\(--pad-x\)\*2\/3\);/);
  assert.ok(padX + padX * 2 / 3 - 7 >= 30, "the tucked part reaches the send square");
});

test("with the box open the switch keeps the bar's place, pressed, and the same press puts the box away", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m49");
  assert.equal(p.page.xcSwitch.hidden, true, "the switch hangs off a card that is not there");
  choose(p, "m49");
  assert.equal(p.page.xcSwitch.hidden, false, "the switch is missing from the card on show");
  card.bottombar.natural = 70.3;   // two lines of a draft when the box is opened
  p.resized(card.bottombar);
  const rest = switchRect(p);
  p.dom.fire(p.page.xcSwitch, "click");
  assert.equal(p.page.xc.host, "m49");
  // the bar sinks away, and neither its run nor its absence moves the switch
  p.resized(card.bottombar);
  assert.deepEqual(switchRect(p), rest, "the switch followed the bar's run down");
  landRun(card);
  p.resized(card.bottombar);
  assert.deepEqual(switchRect(p), rest, "the switch left the bar's place while the box is open");
  assert.equal(p.page.xcSwitch.hidden, false, "the switch went away with the box open");
  assert.equal(p.page.xcSwitch.getAttribute("aria-pressed"), "true");
  assert.equal(p.page.xcSwitch.getAttribute("aria-label"), "put the composer back under the card");
  // between the card and the box, a cell clear of the box's left edge
  const boxLeft = p.stage.rect.left + parseFloat(p.page.xc.root.style.left);
  near(boxLeft - rest.right, 1440 * 0.008, "the air between the switch and the box");
  // the same press, and the bar comes back to where the switch was waiting
  p.dom.fire(p.page.xcSwitch, "click");
  assert.equal(p.page.xc.host, null, "the switch did not put the box away");
  assert.equal(p.page.xcSwitch.getAttribute("aria-pressed"), "false");
  landRun(card);
  const bar = card.bottombar.getBoundingClientRect(), tab = switchRect(p);
  near(tab.top, bar.top, "the switch is off the bar once it is back");
  near(tab.bottom, bar.bottom, "the switch's foot is off the bar once it is back");
});

test("the quick note's corner still wakes and opens, with the switch on the card", async () => {
  const p = openPage({ note: true });
  p.fit();
  addCard(p, "m45");
  choose(p, "m45");
  p.page.switchComposer("right");
  const { dom, page } = p;
  const move = (x, y, target = dom.doc.body) => dom.fire(target, "pointermove",
    { pointerType: "mouse", buttons: 0, clientX: x, clientY: y });
  const out = () => page.qnPeek.classes.has("out");
  const W = 1440, H = 900;
  // the peek's piece when out: 60% of its 160 by 120, in the window's corner
  assert.match(rule("  .qnpeek"), /width:160px; height:120px;/);
  assert.match(rule("  .qnpeek.out"), /transform:translate\(40%, 40%\)/);
  const peek = { left: W - 160 * .6, top: H - 120 * .6 };
  const corner = Number(/const QN_CORNER = (\d+);/.exec(HTML)[1]);
  // the switch hangs off the card, nowhere near the window's corner
  const box = switchRect(p);
  assert.ok(box.right < peek.left || box.bottom < peek.top, "the switch meets the peek");
  // and cannot meet the square that wakes the note wherever the card is put: a
  // card hard in the frame's clear corner still leaves the switch above it
  p.main.rect = { left: 890, right: 1440 - 7 - 16, top: 150, bottom: 900 - 7 - 16 };
  p.fit();
  const far = switchRect(p);
  assert.ok(far.bottom < H - corner, "a card in the corner puts the switch on the note's wake square");
  assert.ok(far.right < W - 7, "a card in the corner puts the switch past the frame");
  p.main.rect = { left: 466.56, right: 996.48, top: 41 + 63.36, bottom: 41 + 789.12 };
  p.fit();
  // a pointer all over the switch never wakes the note
  for (const [x, y] of [[box.left + 8, box.top], [box.right - 1, box.bottom - 1], [box.right - 2, box.top + 30]]){
    move(x, y, page.xcSwitch);
    assert.equal(out(), false, "the switch woke the note at " + x + "," + y);
  }
  // and the corner still does, with the box out and the switch pressed
  move(W - 1, H - 1);
  assert.equal(out(), true, "the corner no longer wakes the note");
  dom.fire(page.qnPeek, "click");
  assert.equal(page.quickNote.root.classes.has("open"), true, "the peek no longer opens the note");
  await settle();
  // the switch still works after, and the note's corner never saw the press
  p.page.xcSwitch.dispatchEvent(Object.assign({ type: "click", preventDefault(){}, stopPropagation(){} }));
  assert.equal(p.page.xc.host, null);
});

test("the switch keeps the caret while it is pressed, and the plus and the square keep it in the box", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m46");
  choose(p, "m46");
  card.ta.focus();
  const down = p.dom.fire(p.page.xcSwitch, "pointerdown");
  assert.equal(down.defaultPrevented, true, "pressing the switch took the caret out of the row");
  p.page.switchComposer("right");
  for (const control of [p.page.xc.clip, p.page.xc.send])
    assert.equal(p.dom.fire(control, "pointerdown").defaultPrevented, true, "a press in the box took the caret out");
  // a press with the caret somewhere else leaves it there
  const other = p.dom.doc.createElement("input"); other.type = "text";
  p.dom.doc.body.appendChild(other);
  p.page.switchComposer("bar");
  other.focus();
  p.page.switchComposer("right");
  assert.equal(p.dom.doc.activeElement, other, "opening the box took the caret from another field");
});
