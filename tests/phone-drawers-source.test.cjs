// What the phone page's two drawers are made of, read out of m.html's source: no
// browser. The card list is the ticket box on the page, above a card that goes
// down 55% of the screen, the two on one fraction and moved by transform alone,
// the box nine tenths of the space the drop opens and seen only above the card;
// the settings are the narrow panel off the right edge. None of what moves is laid
// out again or timed by a script, and nothing the drawers add is purple.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const HTML = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");
const CSS = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...CSS.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));
const rulesFor = pattern => rules.filter(r => pattern.test(r.selector));

const MENUS = HTML.slice(HTML.indexOf("// ---- the two menus, and the one motion they share"),
  HTML.indexOf("// the list's fades, the board's own"));

// the rules the drawers are drawn by
const DRAWER_RULES = /#tikwin|#tickets|#tikhead|#tiklist|\.tikpane|\.tvb|#settings|#scrim|#dockbed|#pane\b/;

function hue([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return { h: 0, chroma: 0 };
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, chroma: d / 255 };
}
function colours(text) {
  const out = [];
  for (const m of text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
    out.push([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]);
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) out.push([+m[1], +m[2], +m[3]]);
  return out;
}

test("nothing the drawers are drawn by uses the accent, purple or violet", () => {
  const mine = rules.filter(r => DRAWER_RULES.test(r.selector));
  assert.ok(mine.length >= 30, `the scan found too few rules to be reading the drawers (${mine.length})`);
  for (const { selector, body } of mine) {
    assert.doesNotMatch(body, /--accent|purple|violet|indigo|magenta/i, `${selector} uses the accent or a purple`);
    for (const c of colours(body)) {
      const { h, chroma } = hue(c);
      assert.ok(!(chroma > 0.08 && h >= 240 && h <= 320), `${selector} carries a violet colour (${c})`);
    }
  }
});

test("the card list is the ticket box on the page above the card, and nothing is left of a side drawer for it", () => {
  assert.doesNotMatch(HTML, /id="drawer"|getElementById\("drawer"\)|#drawer\b/, "the card list's old side drawer is still in the page");
  const page = HTML.slice(HTML.indexOf('<div id="page">'));
  const order = ['id="tickets"', 'id="pane"', 'id="dock"', 'id="dockbed"'].map(one => page.indexOf(one));
  assert.ok(order.every(at => at > 0) && order.every((at, i) => !i || at > order[i - 1]),
    "the page is not the ticket box, then the card, then the row, then the row's bed");
  assert.ok(page.indexOf('id="scrim"') > page.indexOf('id="dockbed"'), "the scrim is inside the page");
});

test("the card goes down 55% of the screen and the box comes in, both on the one fraction", () => {
  assert.match(MENUS, /const LIST_DROP = 0\.55;/);
  const card = rulesFor(/^#pane$/).map(r => r.body).join(";");
  assert.match(card, /transform:translate\(0, calc\(var\(--list-v\) \* var\(--list-drop, 0px\)\)\)/,
    "the card's drop is not the fraction times the drop");
  const box = rulesFor(/^#tickets$/).map(r => r.body).join(";");
  // across, its right edge comes in from the page's left edge; down, it takes back what the window goes down
  assert.match(box, /transform:translate3d\(calc\(\(var\(--list-v\) - 1\) \* \(var\(--pg-l\) \+ 100% \* \(1 \+ var\(--list-share\)\) \/ \(2 \* var\(--list-share\)\)\)\),\s*calc\(-1 \* var\(--list-v\) \* var\(--list-drop, 0px\)\), 0\)/,
    "the box does not come in from the left on the card's fraction, holding still up and down");
  // nine tenths of the card's column and of the drop, in the middle of each (the
  // window it is laid in starts a drop above the page)
  assert.match(box, /--list-share:\.9;/, "the box is not nine tenths of the space");
  assert.match(box, /left:calc\(var\(--pg-l\) \+ \(100% - var\(--pg-l\) - var\(--pg-r\)\) \* \(1 - var\(--list-share\)\) \/ 2\);/);
  assert.match(box, /width:calc\(\(100% - var\(--pg-l\) - var\(--pg-r\)\) \* var\(--list-share\)\);/);
  assert.match(box, /top:calc\(var\(--list-drop, 0px\) \+ var\(--pg-t\) \+ var\(--list-drop, 0px\) \* \(1 - var\(--list-share\)\) \/ 2\);/);
  assert.match(box, /height:calc\(var\(--list-drop, 0px\) \* var\(--list-share\)\);/);
  assert.doesNotMatch(box, /box-shadow:\s*[^n;]|background:\s*(?!transparent)/, "the box paints something of its own");
  // the window the box is seen through: under the card, clipping, its foot on the card's top edge
  const win = rulesFor(/^#tikwin$/).map(r => r.body).join(";");
  assert.match(win, /z-index:0/, "the box does not lie under the card");
  assert.match(win, /overflow:clip/, "the window does not clip the box");
  assert.match(win, /pointer-events:none/, "the window takes a touch");
  assert.match(win, /top:calc\(-1 \* var\(--list-drop, 0px\)\);[\s\S]*height:calc\(var\(--pg-t\) \+ var\(--list-drop, 0px\)\)/,
    "the window does not end at the card's resting top");
  assert.match(win, /transform:translate3d\(0, calc\(var\(--list-v\) \* var\(--list-drop, 0px\)\), 0\)/,
    "the window's foot does not go down with the card");
  const page = HTML.slice(HTML.indexOf('<div id="page">'));
  assert.match(page, /<div id="tikwin"><aside id="tickets"/, "the box is not inside its window");
  // the one fraction is written on the card, the box and the window together
  assert.match(MENUS, /cardPane\.style\.setProperty\("--list-v", num\);\s*tickets\.style\.setProperty\("--list-v", num\);\s*tikwin\.style\.setProperty\("--list-v", num\);/);
  // A tap on the card below closes the list. Row taps are exercised by the
  // behavioral checks in phone-drawer-taps.test.cjs.
  assert.match(MENUS, /page\.addEventListener\("click", e => \{ if \(e\.target === page && drawerOpen\(\)\) closeDrawer\(\); \}\);/);
});

test("what moves for the drawers is a transform or an opacity, and no script carries a frame", () => {
  const moving = rules.filter(r => /^(#pane|#tikwin|#tickets|#settings|#settings::after|#scrim|#dockbed > i|body\.listout #dockbed > i|body\.menurelease #pane|body\.menurelease #tikwin|body\.menurelease #tickets|body\.menurelease #settings)$/.test(r.selector));
  assert.ok(moving.length >= 11, `the scan found too few moving rules (${moving.length})`);
  for (const { selector, body } of moving) {
    for (const [, value] of body.matchAll(/(?:^|;)\s*transition\s*:([^;]*)/g)) {
      for (const one of value.split(/,(?![^()]*\))/)) {
        const property = one.trim().split(/\s+/)[0];
        assert.match(property, /^(transform|opacity|visibility|margin-bottom)$/, `${selector} is timed on ${property}`);
      }
    }
  }
  assert.doesNotMatch(MENUS, /requestAnimationFrame|setInterval|animate\(/, "the menus' script runs a frame loop");
  // the row's bed casts no shadow, and its second sheet stands up for the whole slide:
  // raised as soon as the list is out, lowered over the last of the run home
  assert.equal(rulesFor(/#dockbed::after/).length, 0, "the row's bed draws a shadow along its edge");
  const sheet = rulesFor(/^#dockbed > i$/).map(r => r.body).join(";");
  assert.match(sheet, /transform:translateY\(calc\(var\(--bed-air\) \+ var\(--bed-fade\) - var\(--dock-foot\)\)\)/,
    "the second sheet does not rest with its top on the card's foot");
  assert.match(sheet, /transition:transform var\(--bed-ms\) ease-in calc\(var\(--drawer-ms\) - var\(--bed-ms\)\)/,
    "the second sheet does not wait for the card to come home");
  assert.match(rulesFor(/^body\.listout #dockbed > i$/).map(r => r.body).join(";"), /transform:none; transition:transform var\(--bed-ms\) ease-out/);
  const bed = rulesFor(/^#dockbed::before$/).map(r => r.body).join(";");
  assert.match(bed, /rgba\(0,0,0,1\) var\(--dock-foot\)\)/, "the paper is not whole from the buttons' tops down");
  // the script writes a fraction and nothing about size or place
  const paint = MENUS.slice(MENUS.indexOf("function paintMenu(panel, v){"), MENUS.indexOf("function dismissEditor(){"));
  assert.doesNotMatch(paint, /style\.(left|top|right|bottom|width|height)\b|style\.setProperty\("(left|top|right|bottom|width|height)"/,
    "paintMenu writes a place or a size");
});

test("the settings are the narrow panel off the right edge and the list uses no shade or page depth", () => {
  const settings = rulesFor(/^#settings$/).map(r => r.body).join(";");
  assert.match(settings, /top:0; bottom:0; right:0; width:min\(71\.4vw, 289px\)/, "the settings are not the narrow panel on the right edge");
  assert.doesNotMatch(settings, /left:0|width:100%/, "the settings are the screen's width");
  assert.match(settings, /border-left:var\(--edge\) solid var\(--line\); border-radius:12px 0 0 12px/, "the settings' edge or corners changed");
  assert.match(settings, /transform:translateX\(var\(--shift\)\)/);
  const shade = rulesFor(/^#settings::after$/).map(r => r.body).join(";");
  assert.match(shade, /box-shadow:-2px 0 6px rgba\(0,0,0,\.10\), -10px 0 26px rgba\(0,0,0,\.20\)/, "the settings' shade changed");
  // a pull on the settings is measured against the width they are drawn at, as before the card list moved
  assert.match(MENUS, /function menuTravel\(panel\)\{\s*return panel === tickets \? tickets\.offsetLeft \+ tickets\.offsetWidth : panel\.getBoundingClientRect\(\)\.width;/);
  // the shade and the page's depth belong to the settings alone
  assert.match(MENUS, /\} else \{\s*\/\/ the settings come out on their list[\s\S]*?--scrimv[\s\S]*?--page-scale/);
  const list = MENUS.slice(MENUS.indexOf("if (panel === tickets){"), MENUS.indexOf("} else {", MENUS.indexOf("if (panel === tickets){")));
  assert.doesNotMatch(list, /scrim|--page-scale|--panel-depth/, "the list writes the settings' shade or the page's depth");
});
