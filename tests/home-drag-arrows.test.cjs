// Two small things on the Mac board and its phone twin, checked without a
// browser. (1) With Home open the glass on the house can be lifted and carried
// out onto a project, the mirror of carrying a name's glass onto the house; the
// real drag handlers run here against synthetic geometry (project-lens-fixture).
// (2) The ticket list's two arrows stand in a square of --bar-sq and dip with
// the section names' pressed shade; the sheets and the real press script are
// read as text and run in a vm. This is geometry and rules, not rendering.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fixture, html } = require("./project-lens-fixture.cjs");

const root = path.join(__dirname, "..");
const source = name => readFileSync(path.join(root, name), "utf8");
const css = source("card-tokens.css"), phone = source("m.html");

// ---- (1) the glass out of Home -------------------------------------------------
// the fixture's bar: the house is 0 to 32, the names a 40 to 140, b 140 to 280,
// c 280 to 360, and the row is 7 to 39 down
const shape = f => [f.seat.el.style.width, f.seat.el.style.transform, f.seat.el.classList.contains("round")];
const cls = (f, name) => f.seat.el.classList.contains(name);
const escape = { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} };

test("with Home open a press on the house and a pull sideways lift the glass as a name's is lifted", () => {
  const f = fixture({ home: true }), p = fixture();
  assert.equal(f.context.tabDrag, null);
  f.downHome(); assert.equal(f.context.tabDrag?.home, true, "the house took no press with Home open");
  f.move(19); assert.equal(f.context.tabDrag.mode, null, "a pull under 5px is still a click");
  f.move(22);
  assert.equal(f.context.tabDrag.mode, "select");
  p.down("a"); p.move(150);
  for (const name of ["carried", "still"]) assert.equal(cls(f, name), cls(p, name), name);
  assert.equal(cls(f, "carried"), true); assert.equal(cls(f, "gone"), false);
  // still over the house it is the house's circle, where it stood
  assert.deepEqual(shape(f), ["32px", "translateX(0px)", true]);
  assert.equal(f.context.homeOpen, true); assert.deepEqual(f.switches, []); assert.deepEqual(f.writes, []);
});

test("off the house the glass is a name's and follows the pointer; back on it, the circle: the mirror of a name carried onto the house", () => {
  const f = fixture({ home: true }), p = fixture();
  f.downHome(); f.move(22);
  p.down("a"); p.move(150);
  // over the house both lenses read the same
  f.move(16); p.move(16);
  assert.deepEqual(shape(f), ["32px", "translateX(0px)", true]);
  assert.deepEqual(shape(f), shape(p));
  // in the gap between the house and the first name, the same again
  f.move(36); p.move(36);
  assert.deepEqual(shape(f), ["100px", "translateX(40px)", false]);
  assert.deepEqual(shape(f), shape(p));
  // out over the names it follows the pointer, held inside the strip as a name's is
  f.move(100);
  assert.deepEqual(shape(f), ["100px", "translateX(84px)", false]);
  f.move(330); assert.deepEqual(shape(f), ["100px", "translateX(260px)", false], "held inside the names' strip");
  // and back onto the house it glides there and turns to the circle, as a release slides it
  f.move(16); assert.deepEqual(shape(f), ["32px", "translateX(0px)", true]);
  assert.equal(cls(f, "still"), false, "the shape turns with the release's transition while it is carried");
  assert.equal(f.seat.el.style.transition, f.get("SEAT_GLIDE"));
  assert.equal(f.context.homeOpen, true);
});

test("the glass leaves the house as wide as the name nearest the pointer, and keeps that width until it is back", () => {
  const out = (x, y) => { const f = fixture({ home: true }); f.downHome(); f.move(22); f.move(x, y); return f; };
  assert.deepEqual(shape(out(300)), ["80px", "translateX(280px)", false], "over c, held inside the strip");
  assert.equal(out(200).seat.el.style.width, "140px", "over b");
  assert.equal(out(36).seat.el.style.width, "100px", "between the house and a");
  assert.equal(out(16, 60).seat.el.style.width, "100px", "below the house, nearest a");
  const f = out(300); f.move(100); assert.equal(f.seat.el.style.width, "80px", "held while it crosses the other names");
  f.move(16); assert.equal(f.seat.el.style.width, "32px");
  f.move(200); assert.equal(f.seat.el.style.width, "140px", "taken again from where it leaves the next time");
  // moving off the house downward takes the name's shape too, as it does for a name's glass
  const below = out(16, 60); assert.equal(cls(below, "round"), false);
  below.move(16, 22); assert.equal(cls(below, "round"), true);
});

test("a release over a project opens it with the slide a release onto the house has", () => {
  const f = fixture({ home: true }), g = fixture();
  f.downHome(); f.move(22); f.move(200); f.up(200, 22, f.tabs.b);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.context.homeOpen, false);
  assert.equal(f.seat.owner, "b"); assert.equal(f.seat.x, 140); assert.equal(f.seat.w, 140);
  assert.deepEqual(shape(f), ["140px", "translateX(140px)", false]);
  // the same release as a name's glass dropped on the house: slid, not set down, no longer carried
  g.down("a"); g.move(150); g.move(16); g.up(16, 22, g.homeButton);
  for (const name of ["still", "carried"]) assert.equal(cls(f, name), false, name + " after the release");
  assert.equal(cls(f, "still"), cls(g, "still")); assert.equal(cls(f, "carried"), cls(g, "carried"));
  assert.equal(g.context.homeOpen, true);
  f.tick(0); assert.equal(f.context.tabDrag, null);
  // the project that was open under Home opens too, though it is the active one
  const same = fixture({ home: true }); same.downHome(); same.move(22); same.move(100); same.up(100, 22, same.tabs.a);
  assert.deepEqual(same.switches, ["a"]); assert.equal(same.context.homeOpen, false);
});

test("a release anywhere else sends the glass back to the house, sliding and turning round, and opens nothing", () => {
  for (const [label, x, y, target] of [["below the row", 200, 80, "b"], ["in the gap", 36, 22, "a"], ["past the names", 400, 22, "c"]]) {
    const f = fixture({ home: true });
    f.downHome(); f.move(22); f.move(x, y); f.up(x, y, f.tabs[target]);
    assert.equal(f.context.homeOpen, true, label); assert.deepEqual(f.switches, [], label); assert.deepEqual(f.writes, [], label);
    assert.deepEqual(shape(f), ["32px", "translateX(0px)", true], label);
    assert.equal(cls(f, "still"), false, label + ": the way back slides and turns, as a lens let go off the bar does");
    assert.equal(f.seat.owner, f.get("HOME_SEAT"), label);
  }
  // let go on the house itself: Home stays, the circle stays, and nothing is selected
  const f = fixture({ home: true });
  f.downHome(); f.move(22); f.move(200); f.move(16); f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true); assert.deepEqual(f.switches, []); assert.deepEqual(shape(f), ["32px", "translateX(0px)", true]);
});

test("Escape, blur, a cancelled pointer, a hidden page and a release outside the window put the glass back and select nothing", () => {
  for (const type of ["keydown", "blur", "pointercancel", "visibilitychange"]) {
    const f = fixture({ home: true });
    f.downHome(); f.move(22); f.move(200);
    assert.equal(cls(f, "round"), false, type);
    if (type === "visibilitychange") f.document.visibilityState = "hidden";
    f.dispatch(type, escape);
    assert.deepEqual(shape(f), ["32px", "translateX(0px)", true], type);
    f.up(200, 22, f.tabs.b);
    assert.equal(f.context.homeOpen, true, type); assert.deepEqual(f.switches, [], type);
  }
  const gone = fixture({ home: true }); gone.downHome(); gone.move(22); gone.move(200); gone.move(200, 22, 0);
  assert.equal(gone.context.homeOpen, true); assert.deepEqual(gone.switches, []);
  assert.deepEqual(shape(gone), ["32px", "translateX(0px)", true]);
});

test("a first pull downward from the house does nothing, and the house has no tear-out", () => {
  const f = fixture({ home: true });
  f.downHome(); assert.equal(f.context.tabDrag?.home, true, "the house took no press");
  f.move(18, 80);
  assert.equal(f.context.tabDrag, null, "the pull was kept");
  f.move(200, 90); f.up(200, 90, f.tabs.b);
  assert.deepEqual(f.opens, [], "the house opened a window"); assert.deepEqual(f.switches, []);
  assert.equal(f.context.homeOpen, true); assert.deepEqual(shape(f), ["32px", "translateX(0px)", true]);
  // a name's pull downward still tears it out, once, as before
  const p = fixture(); p.down(); p.move(90, 70); p.up(90, 70);
  assert.equal(p.opens.length, 1);
});

test("the house lifts the glass only for the left button, with Home open and the board not locked", () => {
  const open = fixture({ home: true }); open.downHome(); assert.equal(open.context.tabDrag?.home, true, "the control: Home open, left button");
  const closed = fixture(); closed.downHome(); assert.equal(closed.context.tabDrag, null, "Home closed");
  const right = fixture({ home: true }); right.downHome({ button: 2 }); assert.equal(right.context.tabDrag, null, "right button");
  const locked = fixture({ home: true }); locked.context.LOCKED = true; locked.downHome(); assert.equal(locked.context.tabDrag, null, "locked");
  const glide = fixture({ home: true }); glide.context.tabGlide = 1; glide.downHome(); assert.equal(glide.context.tabDrag, null, "settling");
  // a plain click on the house is untouched: a press and a release with no pull
  const f = fixture({ home: true }); f.downHome(); f.up(16, 22, f.homeButton); f.tick(0);
  assert.equal(f.context.tabDrag, null); assert.equal(f.context.homeOpen, true);
  assert.deepEqual(shape(f), ["32px", "translateX(0px)", true]);
});

test("a drag that began on the house is not a click on it, and its guard runs before the house's other click handlers", () => {
  const stops = f => {
    let n = 0;
    for (const fn of f.homeButton.listeners.click) fn({ stopImmediatePropagation() { n++; } });
    return n;
  };
  const f = fixture({ home: true });
  f.downHome(); f.move(22); f.move(200); f.move(16); f.up(16, 22, f.homeButton);
  assert.equal(stops(f), 1, "the click after a drag from the house was not stopped");
  f.tick(0); assert.equal(stops(f), 0, "a click a moment later is a click");
  const plain = fixture({ home: true }); plain.downHome(); plain.up(16, 22, plain.homeButton);
  assert.equal(stops(plain), 0, "a click with no pull was stopped");
  const guard = html.indexOf('document.getElementById("homeico").addEventListener("click", e => {\n  if (tabDrag?.home');
  assert.ok(guard > 0);
  const later = [...html.matchAll(/document\.getElementById\("homeico"\)\??\.addEventListener\("click"/g)].map(m => m.index).filter(i => i !== guard);
  assert.ok(later.length >= 3 && later.every(i => i > guard), "the guard stands before the other click handlers on the house");
});

test("the glass is not joined to the workspace while it is out, and the joint forms under the project it lands on", () => {
  const f = fixture({ home: true, render: true }), j = f.get("tabJoint");
  const run = ms => { for (let t = 0; t < ms; t += 16) f.tick(16); };
  f.downHome(); f.move(22); f.move(200); run(300);
  assert.equal(j.tau, 0); assert.equal(j.outline, null); assert.equal(j.svg.attributes.opacity, "0");
  f.up(200, 22, f.tabs.b); run(2000);
  assert.equal(f.context.homeOpen, false); assert.equal(j.tau, 1, "joined under the project it landed on"); assert.equal(j.run, null);
  assert.equal(f.seat.owner, "b");
  // released back on nothing it stays on Home, and Home is never joined
  const g = fixture({ home: true, render: true }), k = g.get("tabJoint");
  g.downHome(); g.move(22); g.move(200); g.up(200, 80, g.homeButton);
  for (let t = 0; t < 2000; t += 16) g.tick(16);
  assert.equal(g.context.homeOpen, true); assert.equal(k.tau, 0);
});

test("reorder and the name drag from a project are unchanged by the house's press", () => {
  const f = fixture(); f.tabs.b.classList.add("armed"); f.down("b"); f.move(10); f.move(16);
  assert.equal(f.context.tabDrag.mode, "reorder"); assert.equal(f.context.tabDrag.home, undefined);
  f.up(16, 22, f.homeButton); f.tick(250);
  assert.equal(f.context.homeOpen, false); assert.deepEqual(f.writes[0].order, ["b", "a", "c"]);
  const g = fixture(); g.down("a"); g.move(150); g.move(16);
  assert.deepEqual(shape(g), ["32px", "translateX(0px)", true]); g.up(16, 22, g.homeButton);
  assert.equal(g.context.homeOpen, true);
});

// ---- (2) the ticket list's arrows ------------------------------------------------
const stripped = text => text.replace(/\/\*[\s\S]*?\*\//g, "");
// only the style sheets of a page, so a script's strings cannot read as rules
const sheetOf = text => text.includes("<style") ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n") : text;
// a selector list split at its commas, but not those inside :is( ... )
const selectorsOf = list => { const out = []; let depth = 0, cur = "";
  for (const c of list) { if (c === "(") depth++; if (c === ")") depth--; if (c === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += c; }
  out.push(cur.trim()); return out; };
// every rule whose selector list names the selector, each as its declarations
function decls(text, selector) {
  const rules = [...stripped(sheetOf(text)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => selectorsOf(m[1]).includes(selector));
  return rules.map(m => Object.fromEntries(m[2].split(/;(?![^(]*\))/).filter(s => s.includes(":")).map(s => {
    const at = s.indexOf(":"); return [s.slice(0, at).trim(), s.slice(at + 1).trim().replace(/\s+/g, " ")];
  })));
}
const one = (text, selector) => { const r = decls(text, selector); assert.equal(r.length >= 1, true, selector); return Object.assign({}, ...r); };
const first = (text, selector) => { const r = decls(text, selector); assert.equal(r.length >= 1, true, selector); return r[0]; };

for (const [page, text, u] of [["index.html", html, 1], ["m.html", phone, null]]) {
  test(`${page}: the arrows' press area is a square of --bar-sq, the size every control on the top row stands in`, () => {
    const arrow = one(css, "#tikhead .tik-page");
    assert.equal(arrow.width, "var(--bar-sq)"); assert.equal(arrow.height, "var(--bar-sq)");
    assert.equal(arrow["clip-path"], undefined, "a clip path would cut the press area to the triangle");
    // the same token the card's own buttons use (the sun, the cloud, the moon, the cross and the history arrows)
    const chips = page === "index.html" ? first(text, "body.focus .box.sel .arcbtn") : first(text, ".arcbtn");
    assert.equal(chips.width, "var(--bar-sq)"); assert.equal(chips.height, "var(--bar-sq)");
    assert.match(text, page === "index.html" ? /--bar-sq:24px/ : /--bar-sq:calc\(28 \* var\(--u\)\)/);
    // the button paints nothing of its own: the glass is the triangle's, the dip is the plate's
    for (const key of ["background", "box-shadow", "backdrop-filter", "-webkit-backdrop-filter"]) assert.equal(arrow[key], "none", key);
    assert.equal(arrow.outline, "none", "the square must not grow a focus ring the triangle never had");
    // the triangle stays where it stood: the square centred on the mark's box
    assert.equal(arrow.right, "calc((var(--bar-mark) - var(--bar-sq)) / 2)");
    assert.equal(one(css, "#tikhead .tik-page.back").left, "calc((var(--bar-mark) - var(--bar-sq)) / 2)");
  });

  test(`${page}: pressing an arrow dips its square with the section names' own pressed shade`, () => {
    const name = one(text, "#tikhead .tvb"), pressedName = one(text, "#tikhead .tvb:active");
    const rest = one(css, "#tikhead .tik-page::before");
    const pressed = one(css, '#tikhead .tik-page:not([aria-disabled="true"]):active::before');
    const held = one(css, '#tikhead .tik-page:not([aria-disabled="true"]).pressed::before');
    assert.equal(rest["box-shadow"], name["box-shadow"], "the rest shade is the name's");
    assert.equal(pressed["box-shadow"], pressedName["box-shadow"], "the pressed shade is the name's");
    assert.equal(held["box-shadow"], pressedName["box-shadow"], "and so is a held .pressed");
    assert.ok(pressedName.transition.endsWith(pressed.transition), "in over 80ms: " + pressed.transition);
    assert.ok(name.transition.endsWith(rest.transition), "out over 160ms: " + rest.transition);
    assert.equal(rest["border-radius"], "calc(7 * var(--u))");
    assert.equal(name["border-radius"], page === "index.html" ? "7px" : "calc(7 * var(--u))", "the names' own radius");
    assert.equal(rest.inset, "0"); assert.equal(rest["pointer-events"], "none");
    // a faded arrow does not dip, and neither hover nor focus add a shade
    for (const m of stripped(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1].includes(".tik-page") || !/:active|\.pressed|:hover/.test(m[1])) continue;
      for (const sel of m[1].split(",")) assert.match(sel, /:not\(\[aria-disabled="true"\]\)/, sel);
    }
    assert.doesNotMatch(stripped(css.slice(css.indexOf("#tikhead{margin"), css.indexOf("/* ---- the owner"))), /--accent|432BFF|purple/i);
  });

  test(`${page}: the triangle keeps the glass, size and shape it had, cut from its own box in the middle of the square`, () => {
    const tri = first(css, "#tikhead .tik-page::after");
    assert.equal(tri.width, "var(--bar-mark)"); assert.equal(tri.height, "var(--bar-mark)");
    assert.equal(tri["clip-path"], "polygon(0 0, 100% 50%, 0 100%)");
    assert.equal(tri.left, "50%"); assert.equal(tri.top, "50%");
    assert.equal(tri.margin, "calc(var(--bar-mark) / -2) 0 0 calc(var(--bar-mark) / -2)");
    assert.equal(tri["border-radius"], "0");
    // the material is .qn-glass's, written out for the pseudo-element
    const glass = decls(css, ".qn-glass").find(r => r["box-shadow"]);
    for (const key of ["background-color", "background-image", "backdrop-filter", "-webkit-backdrop-filter", "box-shadow"])
      assert.equal(tri[key], glass[key], key);
    // the focus cue the button had (the triangle turns to ink) is the triangle's now
    assert.equal(one(css, '#tikhead .tik-page:not([aria-disabled="true"]):focus-visible::after')["background-color"], "var(--ink)");
    // and the fallbacks for less transparency and no backdrop blur cover it as they covered the button
    assert.match(css, /prefers-reduced-transparency: reduce\)\{\s*\.qn-glass, #tikhead \.tik-page::after\{background-color:#fff/);
    assert.match(css, /@supports not [^{]+\{\s*\.qn-glass, #tikhead \.tik-page::after\{background-color:rgba\(255,255,255,\.94\)/);
  });
}

// the press script of each page, run as written
for (const [page, text] of [["index.html", html], ["m.html", phone]]) {
  test(`${page}: the real press script gives the arrows .pressed on a pointer or Enter and Space, held at least 80ms`, () => {
    const from = text.indexOf("const PRESS_MIN = 80;");
    assert.ok(from > 0);
    const code = text.slice(from, text.indexOf("\n  }\n", from) + 5);
    const make = () => {
      const listeners = {}, classes = new Set();
      return { listeners, classes, classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, fire(type, e = {}) { (listeners[type] || []).forEach(fn => fn(e)); } };
    };
    const names = [make(), make()], arrows = [make(), make()];
    const timers = new Map(); let now = 0, id = 0;
    const context = vm.createContext({
      document: { querySelectorAll(sel) {
        const parts = sel.split(",").map(s => s.trim());
        return [...(parts.includes("#tikhead .tvb") ? names : []), ...(parts.includes("#tikhead .tik-page") ? arrows : [])];
      } },
      performance: { now: () => now },
      setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: k => timers.delete(k),
    });
    vm.runInContext(code, context);
    const tick = ms => { now += ms; for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.fn(); } };
    for (const arrow of arrows) {
      arrow.fire("pointerdown"); assert.equal(arrow.classes.has("pressed"), true);
      arrow.fire("pointerup"); tick(30); assert.equal(arrow.classes.has("pressed"), true, "a quick click still shows the dip");
      tick(50); assert.equal(arrow.classes.has("pressed"), false);
      arrow.fire("keydown", { key: "Enter" }); assert.equal(arrow.classes.has("pressed"), true);
      arrow.fire("keyup", { key: "Enter" }); tick(80); assert.equal(arrow.classes.has("pressed"), false);
      arrow.fire("keydown", { key: " ", repeat: true }); assert.equal(arrow.classes.has("pressed"), false, "a held key's repeats do not press");
      arrow.fire("keydown", { key: " " }); arrow.fire("blur"); tick(80); assert.equal(arrow.classes.has("pressed"), false);
    }
    // the names went on pressing as before
    names[0].fire("pointerdown"); assert.equal(names[0].classes.has("pressed"), true);
  });
}
