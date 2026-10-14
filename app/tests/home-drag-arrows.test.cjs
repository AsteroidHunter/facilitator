// The ticket list's two arrows on the Mac board and its phone twin, checked
// without a browser: they stand in a square of --bar-sq and dip with the
// section names' pressed shade; the sheets and the real press script are read
// as text and run in a vm. This is geometry and rules, not rendering. (The
// glass carried off the house, this file's other half, went with the lens.)
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = name => readFileSync(path.join(root, name), "utf8");
const css = source("card-tokens.css"), phone = source("m.html"), html = source("index.html");

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
