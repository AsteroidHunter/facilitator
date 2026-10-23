// The limits box's height worked out from the sheet and the nodes the widget
// draws, with no browser: the box is auto-height, so its height is the sum of
// what it holds. Shared by limits-box-height.test.cjs and home-widgets-cache.
const fs = require("node:fs");
const path = require("node:path");
const ROOT = process.env.HOME_SOURCE_ROOT || path.resolve(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "home-widgets.css"), "utf8");
const EDGE = Number(fs.readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").match(/--edge:\s*([\d.]+)px/)[1]);
// the block that only a mouse or trackpad gets, which the Mac board is
const POINTER = /@media \(hover: hover\) and \(pointer: fine\)\{[\s\S]*?\n\}/;

function declarations(selector, { mac = false } = {}) {
  const sheet = (mac ? CSS : CSS.replace(POINTER, "")).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = {};
  for (const match of sheet.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(",").map(s => s.trim()).includes(selector)) continue;
    for (const declaration of match[2].split(";")) {
      const at = declaration.indexOf(":");
      if (at >= 0) out[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim();
    }
  }
  return out;
}

// "calc(16 * var(--u, 1px))" or "16px" to a number of pixels at the page's unit
function px(value, unit = 1) {
  const v = String(value).trim();
  let m = v.match(/^calc\(([\d.]+) \* var\(--u, 1px\)\)$/);
  if (m) return Number(m[1]) * unit;
  m = v.match(/^([\d.]+)px$/);
  if (m) return Number(m[1]);
  if (v === "0") return 0;
  throw new Error("cannot read a length from " + v);
}
// a padding shorthand as [top, right, bottom, left]
function pad(value, unit) {
  const parts = value.match(/calc\([^)]*\)\)|[\d.]+px|0/g).map(p => px(p, unit));
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
}

// the height of the drawn box: border, padding, the title (its line and any
// padding above it), the gap under it, the rows area, and the timestamp line
function boxHeight(panel, { mac = false, unit = 1 } = {}) {
  const d = sel => declarations(sel, { mac });
  const box = { ...d(".tk-panel"), ...d(".lm-box") };
  if (box["box-sizing"] !== "border-box") throw new Error("not a border box");
  if (box.height !== "auto") throw new Error("the box has a height of its own: " + box.height);
  const [top, , bottom] = pad(box.padding, unit);
  const title = d(".lm-title");
  const titleLine = Number(title.font.match(/\/(\d+)px/)[1]);
  const titlePad = title["padding-top"] ? px(title["padding-top"], unit) : 0;
  const rows = d(".lm-rows");
  const rowH = px(rows["grid-auto-rows"], unit), rowGap = px(rows["row-gap"], unit);
  const area = panel.children.find(c => c.className === "lm-rows");
  const shown = area.children.length;
  const wait = area.children.some(c => c.className === "tk-wait");
  const count = wait ? 1 : shown;
  const status = d(".tk-status");
  return 2 * EDGE + top + bottom + titlePad + titleLine + px(rows["margin-top"] || "0", unit)
    + count * rowH + (count - 1) * rowGap
    + px(status["margin-top"], unit) + px(status["min-height"], unit);
}

module.exports = { CSS, EDGE, declarations, px, boxHeight };
