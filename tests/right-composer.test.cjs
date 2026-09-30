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
// the quick note's wiring is parked for v0, and only the skipped corner test below runs it
const NOTE = readFileSync(path.join(ROOT, "parked", "quick-note.js"), "utf8");
const KEYS = HTML.match(/^function boardKeysLive\(\)\{.*\}$/m);

const PRELUDE = `
let FOCUS = true, respMode = "wide", stageScale = 1, selectedId = null, lastState = null;
let activeOwner = "tools", dragging = null, sizing = null;
let qnOpen = false, setOpen = false, editMode = false, pageWarn = null, pageMenu = null, p3Zoom = null;
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
// the panel of sent messages is card-logic.js's own and is proven in
// answered-panel.test.cjs; this stand-in lays nothing out, so here the panel
// only has to take what a send hands it
function syncSent(el, batch){ el.sent = el.sent || h("div", "answered sent"); el.sentBatch = batch; }
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
    "globalThis.page = { els, xc, switchComposer, xcSync, xcPlace,",
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
  // the seat of the panel of sent messages, over the bar, as makeBox builds it
  const sentwrap = el("div"); sentwrap.className = "sentwrap";
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
  pendwrap.append(meta, sentwrap, bottombar);
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
  page.els[id] = { box, replyview, meta, metaNote, ta, send, tick, field,
                   sentwrap, sent: null, sentKey: "", sentItems: [],
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

// ---- the sheet, read as text -------------------------------------------------------
const rule = selector => {
  const at = HTML.indexOf(selector + "{");
  assert.ok(at >= 0, "index.html no longer holds the rule: " + selector);
  return HTML.slice(at + selector.length + 1, HTML.indexOf("}", at));
};

// ---- the tests -----------------------------------------------------------------------

test("no button on the card opens the composer on the right", () => {
  assert.doesNotMatch(HTML, /xcswitch/i, "the page still names the button");
  const p = openPage();
  p.fit();
  addCard(p, "m30");
  choose(p, "m30");
  assert.equal(p.dom.doc.getElementById("xcswitch"), null, "the button is on the page");
  assert.deepEqual(p.stage.children.filter(n => n.tagName && n.tagName.toLowerCase() === "button"), [],
    "a button stands on the stage");
  assert.equal(p.page.xc.root.classes.has("open"), false, "the box opened by itself");
});

test("a stored composer.right = 1 still opens under the card and the key is left alone", async () => {
  const store = storage();
  store.setItem("composer.right", "1");
  const p = openPage({ store });
  p.fit();
  const card = addCard(p, "m29");
  choose(p, "m29");
  assert.equal(p.page.xcRoom, true, "the default card left no room right of it");
  assert.equal(p.page.xc.root.classes.has("open"), false, "the stored choice opened the box");
  assert.equal(p.page.xc.host, null, "the box took the card");
  assert.equal(card.box.classes.has("xcaway"), false, "the bar was put away under the answer");
  p.page.xcSync({ run: true, focus: true });
  assert.equal(p.page.xc.root.classes.has("open"), false, "a later sync read the stored choice");
  assert.equal(store.getItem("composer.right"), "1", "the stored key was changed");
});

test("switchComposer opens the box on the right and puts it away, and the choice is kept in storage", async () => {
  const p = openPage();
  p.fit();
  addCard(p, "m31");
  choose(p, "m31");
  const { page } = p;
  const root = page.xc.root;
  assert.equal(root.parentNode, p.stage, "the box does not stand on the stage");
  assert.equal(page.xcRoom, true, "the default card left no room right of it");
  assert.equal(root.classes.has("open"), false, "the box was out before it was asked for");
  page.switchComposer("right");
  assert.equal(p.store.getItem("composer.right"), "1", "the choice was not kept");
  assert.equal(root.classes.has("open"), true, "the box did not open");
  assert.equal(root.getAttribute("aria-hidden"), "false");
  assert.equal(page.xc.host, "m31");
  // the same page read again with the same store: the key stays, the box does not open
  const q = openPage({ store: p.store });
  q.fit();
  addCard(q, "m31");
  choose(q, "m31");
  assert.equal(q.page.xc.root.classes.has("open"), false, "a reload read the stored choice");
  assert.equal(p.store.getItem("composer.right"), "1", "a reload changed the stored key");
  // and the call again puts it away and forgets the choice
  page.switchComposer();
  assert.equal(p.store.getItem("composer.right"), null);
  assert.equal(root.classes.has("open"), false, "the box stayed out");
  assert.equal(page.xc.host, null);
});

test("switchComposer names either side, and nothing on the page calls it", async () => {
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
  // no key and no button is bound to it: the shared key table does not name
  // it, and the page does not call it
  assert.doesNotMatch(LOGIC, /switchComposer/, "a key already calls it");
  const calls = HTML.split("\n").filter(line => /switchComposer\(/.test(line) &&
    !/^\s*\/\//.test(line) && !/function switchComposer\(/.test(line));
  assert.deepEqual(calls.map(s => s.trim()), [], "something on the page calls switchComposer");
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
  assert.equal(card.sentItems.map(m => m.text).join("\n\n"), "from the bar\n\nfrom the box\n\nby the arrow",
    "the sent panel did not take all three");
  assert.ok(card.sentItems.every(m => m.stage === "sent"), "a send the board answered was not marked as saved");
  assert.ok(card.sent, "no sent panel stands at the card's foot");
  // read out into this side's own array: the batch was built inside the page's sandbox
  assert.deepEqual(Array.from(card.sentBatch, m => m.text), ["from the bar", "from the box", "by the arrow"],
    "the sent panel was not handed all three");
  assert.doesNotMatch(card.metaNote.textContent, /send failed/, "a send from the box failed to land in the sent panel");
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
  assert.ok(p.page.xc.root.classLog.includes("+still"), "the box swung under reduced motion");
  assert.equal(p.page.xc.ta.value, "still words");
  p.page.switchComposer("bar");
  assert.equal(card.box.classes.has("xcaway"), false);
  assert.deepEqual(card.bottombar.style.heights, []);
  assert.equal(card.bar.ta.value, "still words");
  // and the sheet takes every run away under reduced motion: the swing and the
  // bar's run
  const quiet = HTML.slice(HTML.indexOf("  body:is([data-resp-mode=\"portrait\"], [data-resp-mode=\"twopane\"]) #xcomposer"));
  const block = between(quiet, "@media (prefers-reduced-motion: reduce){", "\n  }\n");
  assert.match(block, /body\.focus #xcomposer,\s*body\.focus \.box\.sel \.bottombar\.xcrun\{transition:none\}/);
});

// a list of values split on its own commas and not on those inside brackets,
// however deep; and the runs one rule's transition lists
function topLevel(list){
  const out = [];
  let depth = 0, at = 0;
  for (let i = 0; i < list.length; i++){
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && !depth){ out.push(list.slice(at, i).trim()); at = i + 1; }
  }
  out.push(list.slice(at).trim());
  return out;
}
const runsOf = r => topLevel(/transition:([^;]+);/.exec(r)[1]);

test("the swing is transform and opacity only, 400 to 600ms, clockwise down with a slight settle and back up", () => {
  const tucked = rule("  body.focus #xcomposer");
  const open = rule("  body.focus #xcomposer.open");
  // at rest the assembly is turned 86 degrees anticlockwise about the pivot,
  // and open it wears no transform: from -86 to 0 is clockwise, the way down
  assert.match(tucked, /transform-origin:var\(--xc-pivot-x, 0px\) calc\(100% \+ var\(--xc-pivot-y, 0px\)\);/,
    "the assembly does not turn about the pivot");
  const angle = Number(/transform:rotate\((-?\d+)deg\)/.exec(tucked)[1]);
  assert.ok(angle <= -70 && angle >= -90, "the box is not tucked at 70 to 90 degrees: " + angle);
  assert.match(open, /transform:none;/, "the box keeps a transform at rest");
  assert.match(tucked, /visibility:hidden; pointer-events:none; opacity:0;/);
  assert.match(open, /visibility:visible; pointer-events:auto; opacity:1;/);
  for (const [name, r] of [["up", tucked], ["down", open]]){
    for (const run of runsOf(r)){
      const [prop, dur] = run.split(/\s+/);
      assert.ok(["transform", "opacity", "visibility"].includes(prop), "the swing " + name + " runs " + prop);
      if (prop === "transform"){
        const ms = parseFloat(dur) * 1000;
        assert.ok(ms >= 400 && ms <= 600, "the swing " + name + " runs " + ms + "ms");
      }
    }
    assert.doesNotMatch(r, /filter|blur|mask|height|perspective/, "the swing animates something heavy");
  }
  // down: a curve that lands a little past level and settles back, a few
  // percent and no more; up: the card's own curve, with no overshoot
  const down = runsOf(open).find(s => s.startsWith("transform"));
  const [, , y1, , y2] = /cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(down).map(Number);
  assert.ok(y1 > 1 && y1 <= 1.4 && y2 === 1, "the swing down does not settle, or settles too far: " + down);
  assert.equal(runsOf(tucked).find(s => s.startsWith("transform")), "transform .44s var(--gentle)");
  // the fade comes in over the first part of the way down, and goes out only
  // at the end of the way up, when the card already covers the box
  assert.equal(runsOf(open).find(s => s.startsWith("opacity")), "opacity .2s linear");
  assert.equal(runsOf(tucked).find(s => s.startsWith("opacity")), "opacity .12s linear .32s");
  assert.match(rule("  body.focus #xcomposer.still"), /transition:none/);
  // the box itself never turns: only the assembly does
  assert.doesNotMatch(rule("  body.focus #xcomposer .xcpage"), /transform|transition/);
  // the square is seated again once the swing has landed
  assert.match(RIGHT, /xc\.root\.addEventListener\("transitionend", e => \{\s*if \(e\.target === xc\.root && e\.propertyName === "transform"\) xcTick\(\);/);
});

test("the box hangs from an arm on a pivot at the card's edge, and at rest the card covers it", () => {
  const p = openPage();
  p.fit();
  addCard(p, "m53");
  choose(p, "m53");
  const cell = 1440 * 0.008, st = p.page.xc.root.style;
  // the box, where it stands open: its left edge and its foot at rest height
  const box = { left: parseFloat(st.left), right: parseFloat(st.left) + parseFloat(st.width),
                bottom: 900 - parseFloat(st.bottom) };
  box.top = box.bottom - 12 * cell;
  // the pivot, seen from the box's left edge and foot, is two cells left and
  // the rest of the box's lift below: on the card's right edge at the bar's foot
  near(parseFloat(st.getPropertyValue("--xc-pivot-x")), -2 * cell, "the pivot's reach");
  near(parseFloat(st.getPropertyValue("--xc-pivot-y")), 5 * cell - 20.6, "the pivot's drop");
  const pivot = { x: box.left - 2 * cell, y: box.bottom + 5 * cell - 20.6 };
  near(pivot.x, 996.48, "the pivot is not on the card's right edge");
  near(pivot.y + 41, p.page.els.m53.bottombar.getBoundingClientRect().bottom, "the pivot is not at the bar's foot");
  // the arm: part of the assembly, drawn under the box, from just under the
  // card's edge to the box's foot a quarter of the way along it, in the edge ink
  const arm = p.page.xc.arm;
  assert.equal(arm.parentNode, p.page.xc.root, "the arm does not move with the box");
  assert.deepEqual(p.page.xc.root.children.map(n => n.className), ["xcarm", "xcpage"]);
  assert.match(rule("  body.focus #xcomposer .xcarm"), /border-top:var\(--edge\) solid var\(--line\); transform-origin:0 0/);
  const run = 2 * cell + 6 * cell, rise = -(5 * cell - 20.6);
  near(parseFloat(arm.style.left), -2 * cell, "the arm does not start at the pivot");
  const drop = /^calc\(100% \+ ([\d.]+)px\)$/.exec(arm.style.top);
  assert.ok(drop, "the arm is not hung from the box's foot: " + arm.style.top);
  near(Number(drop[1]), 5 * cell - 20.6, "the arm does not start at the pivot's drop");
  near(parseFloat(arm.style.width), Math.hypot(run, rise) + 3, "the arm's length");
  const turn = Number(/rotate\((-?[\d.e-]+)rad\)/.exec(arm.style.transform)[1]);
  near(turn, Math.atan2(rise, run), "the arm's slant");
  assert.match(arm.style.transform, /translateX\(-3px\)$/, "the arm does not start under the card");
  const end = { x: pivot.x + Math.cos(turn) * (parseFloat(arm.style.width) - 3),
                y: pivot.y + Math.sin(turn) * (parseFloat(arm.style.width) - 3) };
  near(end.x, box.left + 6 * cell, "the arm does not meet the box a quarter along");
  near(end.y, box.bottom, "the arm does not meet the box's foot");
  // tucked: every corner of the box and the arm's far end, turned about the
  // pivot by the sheet's angle, lie inside the card, which stands over them;
  // the pivot itself is the hinge on the card's edge
  const angle = Number(/transform:rotate\((-?\d+)deg\)/.exec(rule("  body.focus #xcomposer"))[1]) * Math.PI / 180;
  const card = { left: 466.56, right: 996.48, top: 63.36, bottom: 789.12 };
  const turned = (q, a) => ({
    x: pivot.x + (q.x - pivot.x) * Math.cos(a) - (q.y - pivot.y) * Math.sin(a),
    y: pivot.y + (q.x - pivot.x) * Math.sin(a) + (q.y - pivot.y) * Math.cos(a) });
  const parts = [{ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.right, y: box.bottom },
                 { x: box.left, y: box.bottom }, end];
  for (const q of parts.map(q => turned(q, angle))){
    assert.ok(q.x < card.right - 10 && q.x > card.left && q.y > card.top && q.y < card.bottom,
      "a part of the tucked box stands out past the card at " + q.x.toFixed(1) + "," + q.y.toFixed(1));
  }
  // and the angle is not idle: at 80 degrees the box's far corner would show
  assert.ok(turned(parts[2], -80 * Math.PI / 180).x > card.right, "a smaller tuck would already hide the box");
  // the card stands over the box: the box keeps the stage's own level after
  // every box on it, and the card is one step up
  assert.doesNotMatch(rule("  body.focus #xcomposer"), /z-index/, "the box does not keep the stage's own level");
  assert.match(rule("  body.focus main"), /z-index:1;/, "the card does not stand over the box");
  assert.ok(p.stage.children.indexOf(p.page.xc.root) > p.stage.children.indexOf(p.main),
    "the box does not come after the card's neighbours on the stage");
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

test("the owner's layout: the box fits beside the card, over the navigator and clear of the frame", () => {
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
  // the box stands over the boxes the owner keeps there, by keeping the stage's
  // own level after them, under the card one step up and the edit handles
  assert.doesNotMatch(rule("  body.focus #xcomposer"), /z-index/);
  assert.match(rule("  body.focus main"), /z-index:1;/);
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
    assert.equal(p.store.getItem("composer.right"), "1", "the choice was dropped in " + mode);
    assert.equal(p.page.switchComposer("right"), true, "asking again in " + mode + " changed the choice");
    assert.equal(p.page.xc.host, null, "the box opened in " + mode);
  }
  // back on the wide board the choice is kept and the box stands again, at once
  p.page.respMode = "wide";
  p.fit();
  assert.equal(p.page.xc.host, "m44");
  assert.equal(p.page.xc.ta.value, "kept through every mode");
  // a card dragged hard against the right: no room, and the box stays away
  p.main.rect = { left: 1000, right: 1300, top: 104, bottom: 830 };
  p.fit();
  assert.equal(p.page.xcRoom, false);
  assert.equal(p.page.xc.host, null);
  assert.equal(p.page.switchComposer("right"), true);
  assert.equal(p.page.xc.host, null, "the box opened with no room");
  // and the sheet takes it away in the two modes whatever the script says
  assert.match(HTML, /body:is\(\[data-resp-mode="portrait"\], \[data-resp-mode="twopane"\]\) #xcomposer\{display:none !important\}/);
  // the board calls the seat every time it fits
  const fit = between(HTML, "function fitStage(){", "\n}\n");
  assert.equal((fit.match(/xcPlace\(\);/g) || []).length, 2, "fitStage does not seat the box on both of its ways out");
});

test("the pivot tracks the bar: a note under it, the sent box and the answered panel above it, a card switch", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m50");
  choose(p, "m50");
  const cell = 1440 * 0.008;
  const drop = () => parseFloat(p.page.xc.root.style.getPropertyValue("--xc-pivot-y"));
  near(drop(), 5 * cell - 20.6, "at rest");
  // the watch is on the bar and on the wrapper it stands in
  const watch = p.watches.find(w => w.els.has(card.bottombar));
  assert.ok(watch, "the bar is not watched");
  assert.ok(watch.els.has(card.pendwrap), "the wrapper the bar stands in is not watched");
  // four lines typed: the bar grows upward from its floor, which stays put
  card.bottombar.natural = 44.8 + 3 * 25.5;
  p.resized(card.bottombar);
  near(drop(), 5 * cell - 20.6, "four lines");
  // a note landing under the bar lifts its floor, and the pivot goes up with it
  card.bottombar.lift = 10;
  p.resized(card.pendwrap);
  near(drop(), 5 * cell - 30.6, "a note under the bar");
  card.bottombar.lift = 0;
  p.resized(card.pendwrap);
  near(drop(), 5 * cell - 20.6, "the note gone");
  // the answered panel is in the answer's own scroller and moves nothing
  p.page.xcSync();
  near(drop(), 5 * cell - 20.6, "the answered panel opened");
  assert.ok(!watch.els.has(card.replyview), "the answer's scroller is watched for nothing");
  // another card: the watch moves over
  const other = addCard(p, "m51", { selected: false });
  other.bottombar.natural = 70.3;
  choose(p, "m51");
  assert.ok(watch.els.has(other.bottombar) && !watch.els.has(card.bottombar), "the watch stayed on the last card's bar");
  // the box open: the bar is away, and the pivot keeps the place the bar rested in
  const rest = drop();
  p.page.switchComposer("right");
  landRun(other);
  p.resized(other.bottombar);
  near(drop(), rest, "the pivot left the bar's place while the box is open");
  // the page's own hooks: the seat is read before any move and after every run
  assert.match(between(HTML, "function xcSync(opts = {}){", "\n}\n"), /^\s*xcSeat\(\);/m);
  assert.match(between(HTML, "function xcLanded(el, end){", "\n}\n"), /xcSeat\(\);/);
});

test("the quick note's corner still wakes and opens, with the box out", { skip: "feature hidden for v0" }, async () => {
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
  // the corner wakes the note with the box out
  move(W - 1, H - 1);
  assert.equal(out(), true, "the corner no longer wakes the note");
  dom.fire(page.qnPeek, "click");
  assert.equal(page.quickNote.root.classes.has("open"), true, "the peek no longer opens the note");
  await settle();
  // the box still goes away after
  p.page.switchComposer("bar");
  assert.equal(p.page.xc.host, null);
});

test("the plus and the square keep the caret in the box", () => {
  const p = openPage();
  p.fit();
  const card = addCard(p, "m46");
  choose(p, "m46");
  card.ta.focus();
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
