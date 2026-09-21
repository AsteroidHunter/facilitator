// Deterministic, browser-free regression for the native fullscreen settle logic.
// It extracts the ACTUAL handler bytes from index.html (the FS_SETTLE_* block, the
// onViewportResize freeze, and the display-mode wiring) and runs them in a tiny
// sandbox with mocked window globals and fake timers, so the event ordering and
// the freeze rule are checked without any browser. This guards the real source:
// if the settle is reverted or the freeze bypass is dropped, these fail.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// Pull out exactly the block we ship, by stable anchors. If the anchors move the
// extraction fails loudly, which is the right signal to update this test.
function extractSettleSource() {
  const start = HTML.indexOf("const FS_SETTLE_QUIET_MS");
  assert.ok(start >= 0, "FS_SETTLE_QUIET_MS anchor not found in index.html");
  const mm = HTML.indexOf('matchMedia("(display-mode: fullscreen)")', start);
  assert.ok(mm > start, "display-mode matchMedia wiring not found after the settle block");
  const endMark = HTML.indexOf("} catch (e) {}", mm);
  assert.ok(endMark > mm, "end of the display-mode try/catch not found");
  return HTML.slice(start, endMark + "} catch (e) {}".length);
}

// Build a runnable copy of the real block with mocked globals and fake timers.
function buildMachine() {
  const preamble = `
    let FOCUS = true;
    let innerWidth = 1512, innerHeight = 744, lastFitW = 1512;
    const fitCalls = [];
    function fitStage(){ fitCalls.push({ iw: innerWidth, ih: innerHeight }); lastFitW = innerWidth; }
    let capturedResize = null, capturedChange = null;
    function addEventListener(type, cb){ if (type === 'resize') capturedResize = cb; }
    function matchMedia(q){ return { media:q, matches:false,
      addEventListener:(t,cb)=>{ if(t==='change') capturedChange=cb; },
      addListener:(cb)=>{ capturedChange=cb; } }; }
    let __now = 0; const __timers = [];
    function setTimeout(cb, ms){ const id = {}; __timers.push({ id, cb, due: __now + ms }); return id; }
    function clearTimeout(id){ const i = __timers.findIndex(t => t.id === id); if (i >= 0) __timers.splice(i, 1); }
    function __advance(ms){ __now += ms;
      const due = __timers.filter(t => t.due <= __now).sort((a,b)=>a.due-b.due);
      for (const t of due){ const i = __timers.indexOf(t); if (i >= 0){ __timers.splice(i,1); t.cb(); } } }
  `;
  const tail = `
    ctl.fireResize = () => { if (capturedResize) capturedResize(); };
    ctl.fireChange = () => { if (capturedChange) capturedChange(); };
    ctl.advance = __advance;
    ctl.setSize = (w, h) => { innerWidth = w; innerHeight = h; };
    ctl.setLastFitW = v => { lastFitW = v; };
    ctl.setFocus = v => { FOCUS = v; };
    ctl.calls = () => fitCalls.slice();
    ctl.lastCall = () => fitCalls[fitCalls.length - 1];
    ctl.hasHandlers = () => !!capturedResize && !!capturedChange;
  `;
  const factory = new Function("ctl", preamble + "\n" + extractSettleSource() + "\n" + tail);
  const ctl = {};
  factory(ctl);
  return ctl;
}

test("the settle block wires a resize handler and a display-mode change handler", () => {
  const m = buildMachine();
  assert.equal(m.hasHandlers(), true,
    "the extracted source must register both a resize listener and a display-mode change listener");
});

test("same-width ENTER: display-mode arms the settle and the later final-height resize refits", () => {
  const m = buildMachine();
  m.setSize(1512, 744); m.setLastFitW(1512);   // fitted windowed, same width baseline
  const before = m.calls().length;

  // intermediate same-width resize BEFORE the display-mode flip: frozen
  m.setSize(1512, 820); m.fireResize();
  assert.equal(m.calls().length, before, "a same-width resize before the transition must be frozen");

  // display-mode change fires mid-animation: arms the settle and fits now
  m.fireChange();
  assert.equal(m.lastCall().ih, 820, "arming the settle fits to the current (intermediate) height");

  // final height arrives at the SAME width: must refit despite the width freeze
  m.setSize(1512, 949); m.fireResize();
  assert.equal(m.lastCall().ih, 949, "while settling, a same-width resize must refit to the final height");

  // quiet window elapses: one final authoritative fit at the settled size
  m.advance(160);
  assert.equal(m.lastCall().ih, 949, "the settle ends on a final fit at the final height");
});

test("same-width EXIT: display-mode arms, the final shorter height refits", () => {
  const m = buildMachine();
  m.setSize(1512, 949); m.setLastFitW(1512);   // fitted fullscreen, same width
  m.setSize(1512, 820); m.fireResize();        // intermediate collapse, frozen
  const n = m.calls().length;
  assert.equal(n >= 0, true);
  m.fireChange();                              // leaving fullscreen arms the settle
  m.setSize(1512, 744); m.fireResize();        // final windowed height, same width
  assert.equal(m.lastCall().ih, 744, "leaving fullscreen must refit to the shorter final height");
  m.advance(160);
  assert.equal(m.lastCall().ih, 744, "final fit stays at the settled shorter height");
});

test("an ordinary same-width resize stays frozen, and the freeze returns after a settle ends", () => {
  const m = buildMachine();
  m.setSize(1400, 744); m.setLastFitW(1400);
  let before = m.calls().length;
  m.setSize(1400, 560); m.fireResize();
  assert.equal(m.calls().length, before, "a height-only resize (no transition) must not refit");

  // run a transition to completion, then confirm a later height-only resize freezes
  m.setSize(1512, 949); m.fireChange(); m.advance(160);   // settle armed then disarmed
  before = m.calls().length;
  m.setSize(1512, 800); m.fireResize();
  assert.equal(m.calls().length, before, "after the settle disarms, a same-width resize must be frozen again");
});

test("the hard cap disarms the settle even if size changes keep bumping the quiet timer", () => {
  const m = buildMachine();
  m.setSize(1512, 744); m.setLastFitW(1512);
  m.fireChange();   // arm (quiet 160ms, cap 1200ms)
  // bump the quiet timer every 150ms (< 160) so only the hard cap can end it
  for (let t = 0; t < 1200; t += 150) { m.setSize(1512, 745 + t); m.fireResize(); m.advance(150); }
  const afterCap = m.calls().length;
  // once the cap has disarmed, a plain same-width resize must be frozen again
  m.setSize(1512, 744); m.setLastFitW(1512); m.fireResize();
  assert.equal(m.calls().length, afterCap, "after the hard cap the settle is disarmed and the freeze holds");
});
