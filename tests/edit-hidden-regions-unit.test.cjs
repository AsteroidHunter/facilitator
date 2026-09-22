// Deterministic, browser-free regression for the edit-mode treatment of removed
// widgets. It extracts the ACTUAL trackHandles, toggleRegionHidden, regionHidden
// and DEFAULT_HIDDEN_REGIONS bytes from index.html and runs them in tiny
// sandboxes with fake DOM/localStorage, plus reads the shipped stylesheet, so
// the fix is pinned against the real source rather than a paraphrase of it.
//
// What it guards:
//   - a removed box stays visually gone in edit mode (no faint ghost): the
//     stylesheet no longer flips .region-off back to visible under .editmode.
//   - a removed box carries no floating control while arranging: trackHandles
//     takes down BOTH its resize handles and its corner cross, and the old
//     restore ("show this box") affordance is gone from source.
//   - hiding a visible box flips it into that hidden-and-controlless state on the
//     very next frame (immediate removal of the box and every control on it).
//   - toggleRegionHidden writes only per-tab hide/show keys and never rewrites a
//     saved position or size, so arranging does not disturb custom layouts.
//   - per-project visibility, the four-widget default layout, an explicit
//     reveal, and a data-driven markdown reader all still resolve correctly.
//
// Every lane/owner name here is invented, never a configured project name.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// pull a run of bytes between two stable anchors, failing loudly if either moves
function between(startAnchor, endMark) {
  const start = HTML.indexOf(startAnchor);
  assert.ok(start >= 0, "anchor not found: " + startAnchor);
  const end = HTML.indexOf(endMark, start);
  assert.ok(end > start, "end mark not found: " + endMark);
  return HTML.slice(start, end + endMark.length);
}

// a function body by brace matching, so a nested block cannot cut it short
function fnSource(signature) {
  const start = HTML.indexOf(signature);
  assert.ok(start >= 0, "function not found: " + signature);
  let depth = 0, i = HTML.indexOf("{", start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + signature);
}

const HIDDEN_SET = between("const DEFAULT_HIDDEN_REGIONS = new Set([", "]);");
const REGION_HIDDEN = fnSource("function regionHidden(owner, id)");
const TOGGLE = fnSource("function toggleRegionHidden(id)");
const TRACK = fnSource("function trackHandles(){");

// ---- stylesheet: a removed box is not resurrected while arranging -----------

test("the stylesheet hides a removed box and never flips it back on in edit mode", () => {
  assert.ok(
    HTML.includes("body.focus .region-off{visibility:hidden; pointer-events:none}"),
    "the base rule that hides a removed box must remain");
  // the old override made .region-off visibility:visible;opacity:.35 under
  // .editmode, which is exactly the ghost the user rejected. it must be gone,
  // and nothing else may set a removed box back to visible.
  assert.ok(
    !/\.region-off\s*\{[^}]*visibility\s*:\s*visible/.test(HTML),
    "no rule may set .region-off back to visibility:visible");
  assert.ok(
    !HTML.includes("body.focus.editmode .region-off"),
    "the edit-mode ghost override for .region-off must be removed");
});

test("the restore-cross styling and its show affordance are gone from source", () => {
  assert.ok(!/\.rkill\.restore/.test(HTML),
    "the .rkill.restore (plus-shaped restore cross) styling must be removed");
  assert.ok(!HTML.includes('classList.toggle("restore"'),
    "the restore class toggle in trackHandles must be removed");
  assert.ok(!HTML.includes("show this box on this tab"),
    "the restore ('show this box on this tab') affordance must be gone");
});

// ---- trackHandles: removed boxes wear no handles and no cross ---------------

// a minimal element: just what trackHandles reads off it
function fakeRegion(off) {
  const cls = new Set(off ? ["region-off"] : []);
  return {
    classList: {
      contains: c => cls.has(c),
      add: c => cls.add(c),
      remove: c => cls.delete(c),
    },
    // a real, non-empty box so the size guard is never the reason a control hides
    getBoundingClientRect: () => ({ x: 100, y: 80, width: 200, height: 150 }),
  };
}
function fakeControl() { return { style: {}, title: "" }; }

function buildTrack() {
  const preamble = `
    let handleItems = [];
    let killItems = [];
    let handleRaf = 0;
    let rafCount = 0;
    const stageScale = 1;
    const document = { getElementById: () => ({
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    }) };
    // one-shot: return a token, never re-run trackHandles, so the test controls frames
    const requestAnimationFrame = () => { rafCount++; return 1; };
  `;
  const tail = `
    ctl.setItems = (h, k) => { handleItems = h; killItems = k; };
    ctl.frame = () => trackHandles();
    ctl.rafCount = () => rafCount;
  `;
  const ctl = {};
  new Function("ctl", preamble + "\n" + TRACK + "\n" + tail)(ctl);
  return ctl;
}

// build 8 handle items + 1 cross item for a region, matching buildHandles' shape
function itemsFor(region) {
  const dirs = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const handles = dirs.map(dir => ({ el: region, dir, hd: fakeControl() }));
  const kill = { el: region, kill: fakeControl() };
  return { handles, kill };
}

test("a visible box shows all eight handles and its cross", () => {
  const t = buildTrack();
  const region = fakeRegion(false);
  const { handles, kill } = itemsFor(region);
  t.setItems(handles, [kill]);
  t.frame();
  for (const h of handles) assert.equal(h.hd.style.display, "", "each handle must show for a visible box");
  assert.equal(kill.kill.style.display, "", "the cross must show for a visible box");
  assert.equal(kill.kill.title, "hide this box on this tab");
  assert.equal(t.rafCount(), 1, "trackHandles must re-arm the frame loop");
});

test("a removed box shows no handles and no cross", () => {
  const t = buildTrack();
  const region = fakeRegion(true);
  const { handles, kill } = itemsFor(region);
  t.setItems(handles, [kill]);
  t.frame();
  for (const h of handles) assert.equal(h.hd.style.display, "none", "a removed box must wear no handle");
  assert.equal(kill.kill.style.display, "none", "a removed box must carry no cross");
  // the removed box never gets a restore title or restore class
  assert.notEqual(kill.kill.title, "show this box on this tab");
  assert.equal(kill.kill.classList, undefined, "the cross control is a plain style/title holder now");
});

test("hiding a visible box removes the box's handles and cross on the next frame", () => {
  const t = buildTrack();
  const region = fakeRegion(false);
  const { handles, kill } = itemsFor(region);
  t.setItems(handles, [kill]);
  // frame 1: visible, everything shown
  t.frame();
  assert.equal(kill.kill.style.display, "");
  assert.equal(handles[0].hd.style.display, "");
  // the user clicks the cross: applySavedLayout adds region-off to this element
  region.classList.add("region-off");
  // frame 2: the very next tick takes the box's controls down with it
  t.frame();
  for (const h of handles) assert.equal(h.hd.style.display, "none", "handle must vanish immediately");
  assert.equal(kill.kill.style.display, "none", "cross must vanish immediately");
});

// ---- regionHidden / toggleRegionHidden: state without a browser -------------

function buildRegions(seed) {
  const preamble = `
    let activeOwner = "facilitator";
    let MD_MOUNTS = {};
    let applyCalls = 0;
    const writes = [];
    const __store = new Map(${JSON.stringify(Object.entries(seed || {}))});
    const localStorage = {
      getItem: k => __store.has(k) ? __store.get(k) : null,
      setItem: (k, v) => { writes.push(["set", k]); __store.set(k, String(v)); },
      removeItem: k => { writes.push(["remove", k]); __store.delete(k); },
    };
    function applySavedLayout(){ applyCalls++; }
  `;
  const tail = `
    ctl.regionHidden = (o, id) => regionHidden(o, id);
    ctl.toggle = id => toggleRegionHidden(id);
    ctl.setOwner = o => { activeOwner = o; };
    ctl.setMounts = m => { MD_MOUNTS = m; };
    ctl.get = k => localStorage.getItem(k);
    ctl.writes = () => writes.slice();
    ctl.applyCalls = () => applyCalls;
    ctl.defaultHidden = DEFAULT_HIDDEN_REGIONS;
  `;
  const ctl = {};
  new Function("ctl",
    preamble + "\n" + HIDDEN_SET + "\n" + REGION_HIDDEN + "\n" + TOGGLE + "\n" + tail)(ctl);
  return ctl;
}

test("the default four-widget layout: only the four core boxes show on a fresh lane", () => {
  const r = buildRegions();
  const owner = "willow";
  for (const id of ["main", "clockbox", "tickets", "magic1"])
    assert.equal(r.regionHidden(owner, id), false, id + " must be one of the four default-visible boxes");
  for (const id of ["rail", "magic2", "magic3", "magic4", "goalbox"])
    assert.equal(r.regionHidden(owner, id), true, id + " must be hidden by default");
  // the default-hidden set is exactly these five and no more
  assert.deepEqual([...r.defaultHidden].sort(),
    ["goalbox", "magic2", "magic3", "magic4", "rail"]);
});

test("hiding a visible box marks it hidden for this tab only and reapplies the layout", () => {
  const r = buildRegions();
  r.setOwner("cedar");
  assert.equal(r.regionHidden("cedar", "magic1"), false);
  r.toggle("magic1");
  assert.equal(r.get("hide.cedar.magic1"), "1", "an explicit hide key is written for this tab");
  assert.equal(r.regionHidden("cedar", "magic1"), true, "the box is now hidden on this tab");
  assert.equal(r.regionHidden("birch", "magic1"), false, "another tab is untouched");
  assert.ok(r.applyCalls() >= 1, "toggling must reapply the layout so the change shows at once");
});

test("restoring a removed box clears the hide and reveals it on this tab only", () => {
  const r = buildRegions({ "hide.cedar.magic1": "1" });
  r.setOwner("cedar");
  assert.equal(r.regionHidden("cedar", "magic1"), true);
  r.toggle("magic1");
  assert.equal(r.get("hide.cedar.magic1"), null, "the hide key is cleared");
  assert.equal(r.get("show.cedar.magic1"), "1", "an explicit show key is written");
  assert.equal(r.regionHidden("cedar", "magic1"), false);
});

test("toggling visibility never rewrites a saved position or size", () => {
  // a lane with a custom layout already saved for the box being toggled
  const r = buildRegions({
    "pos.cedar.magic1": JSON.stringify({ x: 300, y: 200 }),
    "size.cedar.magic1": JSON.stringify({ w: 400, h: 320 }),
  });
  r.setOwner("cedar");
  r.toggle("magic1");   // hide
  r.toggle("magic1");   // restore
  for (const [, key] of r.writes())
    assert.ok(!/^(pos|size)\./.test(key),
      "hiding/restoring must not touch a saved position or size key, but wrote " + key);
  // the custom layout survives untouched
  assert.equal(r.get("pos.cedar.magic1"), JSON.stringify({ x: 300, y: 200 }));
  assert.equal(r.get("size.cedar.magic1"), JSON.stringify({ w: 400, h: 320 }));
});

test("per-project visibility survives a reload (keys are read back per tab)", () => {
  // simulate a reload: rebuild from the persisted store
  const seed = { "hide.cedar.magic1": "1", "show.cedar.magic2": "1" };
  const r = buildRegions(seed);
  assert.equal(r.regionHidden("cedar", "magic1"), true, "cedar's hidden box stays hidden after reload");
  assert.equal(r.regionHidden("cedar", "magic2"), false, "cedar's revealed box stays revealed after reload");
  assert.equal(r.regionHidden("birch", "magic1"), false, "birch is unaffected by cedar's choices");
  assert.equal(r.regionHidden("birch", "magic2"), true, "birch keeps the default for magic2");
});

test("a data-driven markdown reader shows by default and still honours an explicit hide", () => {
  const r = buildRegions();
  r.setMounts({ alder: { box: "magic4" } });
  assert.equal(r.regionHidden("alder", "magic4"), false, "the lane's configured reader shows without a show key");
  assert.equal(r.regionHidden("spruce", "magic4"), true, "a lane with no reader keeps magic4 hidden by default");
  // an explicit hide still wins over the reader default
  const r2 = buildRegions({ "hide.alder.magic4": "1" });
  r2.setMounts({ alder: { box: "magic4" } });
  assert.equal(r2.regionHidden("alder", "magic4"), true, "an explicit hide must win over the reader default");
});
