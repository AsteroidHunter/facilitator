// The phone's card list follows the board's ticket names: Doing, Deferred and
// Done, capitalized, the selected one marked by weight and ink with no pill, and
// every name dipping while pressed. Like the board it draws no recessed well
// around the list: the rows sit straight on the paper. The board's list stands
// on the paper too, its edges fading. Read from the sources, with no browser, so a drift on
// either page is caught wherever the suite runs.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => readFile(path.join(ROOT, name), "utf8");

// every plain rule in the page's style blocks, comments stripped, as its
// selector list and its declarations in source order. rules inside an at-rule
// are found too, since only the innermost braces are matched
function rulesOf(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")),
    decls: m[2].split(";").map(d => d.trim()).filter(Boolean).map(d => {
      const at = d.indexOf(":");
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    }),
  }));
}
// what the rules written for exactly this selector say, later ones winning
function declsFor(rules, selector) {
  const out = {};
  for (const r of rules) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) out[k] = v;
  return out;
}
// every declaration any rule makes for an element whose last compound is this id
function declsOnId(rules, id) {
  const subject = new RegExp(`(^|[ >+~])#${id}(:[\\w-]+)?$`);
  return rules.filter(r => r.selectors.some(s => subject.test(s))).flatMap(r => r.decls);
}
const labels = html => ["todo", "docked", "deferred", "done"].map(v => {
  const m = new RegExp(`<button id="tv-${v}"[^>]*>([^<]*)</button>`).exec(html);
  assert.ok(m, `the tv-${v} button is on the page`);
  return m[1];
});

const REST = "inset 0 0 0 rgba(60,45,20,0), inset 0 0 0 rgba(60,45,20,0)";
// the --sunk-deep recipe at 0.6 depth, the board's press dip
const DIP = "inset 0 1.8px 4.2px rgba(60,45,20,.132), inset 0 .6px 1.2px rgba(60,45,20,.084)";

test("the phone drawer's tab names are capitalized like the board's", async () => {
  const [phone, board] = await Promise.all([read("m.html"), read("index.html")]);
  assert.deepEqual(labels(phone), ["Doing", "Docked", "Deferred", "Done"]);
  assert.deepEqual(labels(phone), labels(board), "the phone's names differ from the board's");
  // only the doing name starts selected
  assert.match(phone, /<button id="tv-todo" class="ptab tvb on"/);
  assert.match(phone, /<button id="tv-deferred" hidden class="ptab tvb"/);
  assert.match(phone, /<button id="tv-done" hidden class="ptab tvb"/);
});

test("the phone drawer's selected tab wears no pill and reads by weight", async () => {
  const rules = rulesOf(await read("m.html"));
  const name = declsFor(rules, "#tikhead .tvb");
  const on = declsFor(rules, "#tikhead .tvb.on");
  // a clear edge on all four sides of every name, so selection moves nothing,
  // and the ID-scoped shorthand outranks .ptab.on's hairline colour
  assert.equal(name.border, "var(--edge) solid transparent");
  assert.equal(name["font-size"], "calc(14 * var(--u))", "the names are not a pixel over the phone's 13px tabs");
  assert.equal(name["box-shadow"], REST, "a name stands in a shade at rest");
  assert.equal(name["border-radius"], "calc(7 * var(--u))");
  // selection is weight and ink, with no fill, edge or shade of its own
  assert.equal(on["font-weight"], "700");
  assert.equal(on.color, "var(--ink)");
  assert.equal(on.background, "transparent", "the selected name is filled");
  for (const k of Object.keys(on))
    assert.ok(!/^(border|box-shadow|outline)/.test(k), `the selected name still sets ${k}`);
  // no rule anywhere in the page puts a pill back behind the selected name
  for (const r of rules) {
    const hit = r.selectors.filter(s => /#tikhead .tvb.on$|^#tv-(todo|docked|deferred|done)(\.on)?$/.test(s));
    if (!hit.length) continue;
    for (const [k, v] of r.decls) {
      assert.ok(!/^box-shadow$|^outline/.test(k), `${hit} sets ${k}: ${v}`);
      if (/^background/.test(k)) assert.equal(v, "transparent", `${hit} fills the selected name`);
      if (/^border/.test(k) && k !== "border-radius") assert.match(v, /transparent/, `${hit} draws an edge`);
    }
  }
  // the seated-tab notches stay struck
  assert.equal(declsFor(rules, "#tikhead .tvb.on::before").display, "none");
  assert.equal(declsFor(rules, "#tikhead .tvb.on::after").display, "none");
  // the press dip, on any name held
  assert.equal(declsFor(rules, "#tikhead .tvb:active")["box-shadow"], DIP);
  assert.equal(declsFor(rules, "#tikhead .tvb.pressed")["box-shadow"], DIP);
});

test("the phone asks for Plex Sans at 700 so the selected weight is not faked", async () => {
  const phone = await read("m.html");
  const sheet = /"(https:\/\/fonts\.googleapis\.com\/css2\?[^"]*IBM\+Plex\+Sans[^"]*)"/.exec(phone);
  assert.ok(sheet, "the phone's font sheet is on the page");
  assert.match(sheet[1], /IBM\+Plex\+Sans:wght@[\d;]*\b700\b/);
});

test("a press dips a phone tab for at least 80ms, by finger and by key", async () => {
  const phone = await read("m.html");
  const start = phone.indexOf("// press feedback, as on the board");
  const end = phone.indexOf('document.getElementById("tikadd")', start);
  assert.ok(start >= 0 && end > start, "the press script is beside the tab taps");
  class Name {
    constructor(id) { this.id = id; this.on = {}; this.set = new Set(); }
    addEventListener(type, fn) { (this.on[type] ||= []).push(fn); }
    fire(type, e = {}) { for (const fn of this.on[type] || []) fn(e); }
    get classList() {
      const set = this.set;
      return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
    }
  }
  const names = ["tv-todo", "tv-docked", "tv-deferred", "tv-done"].map(id => new Name(id));
  let now = 0;
  let timers = [];
  const context = {
    document: { querySelectorAll: sel => (assert.equal(sel, "#tikhead .tvb"), names) },
    performance: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
  };
  vm.runInNewContext(phone.slice(start, end), context);
  const advance = ms => {
    now += ms;
    for (const t of timers.filter(t => t.at <= now)) { t.fn(); t.fn = () => {}; }
  };
  const [todo, deferred] = names;

  // a quick tap: down and up at once still holds the dip for its 80ms
  todo.fire("pointerdown");
  todo.fire("pointerup");
  assert.equal(todo.classList.contains("pressed"), true);
  advance(20);
  assert.equal(todo.classList.contains("pressed"), true, "the dip rose before its 80ms");
  advance(60);
  assert.equal(todo.classList.contains("pressed"), false, "the dip stayed after its 80ms");

  // a long hold rises as soon as the finger lifts or the browser takes the touch
  deferred.fire("pointerdown");
  advance(300);
  assert.equal(deferred.classList.contains("pressed"), true);
  deferred.fire("pointercancel");
  advance(0);
  assert.equal(deferred.classList.contains("pressed"), false);

  // Space and Enter press it too, and a repeat is not a second press
  deferred.fire("keydown", { key: " ", repeat: false });
  assert.equal(deferred.classList.contains("pressed"), true);
  advance(200);
  deferred.fire("keydown", { key: " ", repeat: true });
  deferred.fire("keyup", { key: " " });
  advance(0);
  assert.equal(deferred.classList.contains("pressed"), false);
  deferred.fire("keydown", { key: "a", repeat: false });
  assert.equal(deferred.classList.contains("pressed"), false, "a letter pressed the name");
});

test("the phone card list lists tickets with no embedded well around them", async () => {
  const rules = rulesOf(await read("m.html"));
  const list = declsOnId(rules, "tiklist");
  // nothing that would draw the box: no fill, edge, rounding, inset shade or
  // outline. the list reaches out past the holder on both sides and past its foot
  // by negative margins, as the board's does, so a lifted row's shadow is not cut
  for (const [k, v] of list)
    assert.ok(!/^(background|border|box-shadow|outline)/.test(k), `#tiklist still sets ${k}: ${v}`);
  // it still clips the sheet of three sections and fills the holder below the names
  const own = declsFor(rules, "#tiklist");
  assert.equal(own.overflow, "clip");
  assert.equal(own.flex, "1");
  assert.equal(own["min-height"], "0");
  assert.equal(own.margin, "0 calc(var(--list-side) * -1) calc(var(--list-air) * -1)");
  // the rows keep their spacing through each section's own padding and gap, which
  // pad back in by the amount the list reaches out, so every row stands in line
  // with the names above
  const pane = declsFor(rules, ".tikpane");
  assert.equal(pane.gap, "calc(6 * var(--u))");
  assert.equal(pane["overflow-y"], "auto");
  assert.match(pane.padding, /var\(--list-side\)/);
  assert.match(declsFor(rules, "#tikhead").padding, /^calc\(6 \* var\(--u\)\) 0 0$/);
  // the rows themselves keep their own edge, fill and shade
  const row = declsFor(rules, ".trow");
  assert.equal(row.border, "var(--edge) solid var(--line)");
  assert.equal(row["border-radius"], "calc(5 * var(--u))");
  assert.equal(row.background, "#fff");
});

test("the board is unchanged: capitalized names, no pill, and its list on the paper with faded edges", async () => {
  const board = await read("index.html");
  const rules = rulesOf(board);
  assert.deepEqual(labels(board), ["Doing", "Docked", "Deferred", "Done"]);
  const name = declsFor(rules, "#tikhead .tvb");
  const on = declsFor(rules, "#tikhead .tvb.on");
  assert.equal(name.border, "1px solid transparent");
  assert.equal(name["font-size"], "14px");
  assert.equal(name["box-shadow"], REST);
  assert.equal(on["font-weight"], "700");
  assert.equal(on.background, "transparent");
  assert.equal(declsFor(rules, "#tikhead .tvb.pressed")["box-shadow"], DIP);
  assert.match(board, /IBM\+Plex\+Sans:wght@[\d;]*\b700\b/);
  // the board's list stands on the paper: no fill, edge, corner or shade of its
  // own, still clipping the sheet of three sections
  const list = declsFor(rules, "#tiklist");
  for (const key of ["background", "border", "border-radius", "box-shadow"])
    assert.equal(key in list, false, `#tiklist still sets ${key}: ${list[key]}`);
  assert.equal(list.overflow, "clip");
  // a thin divider in --line sits under the three names, and each section's top
  // and foot fade under a mask sized by how far it has scrolled and how far it can
  assert.equal(declsFor(rules, "#tikhead::after")["border-top"], "var(--edge) solid var(--line)");
  const pane = declsFor(rules, ".tikpane");
  assert.match(pane["mask-image"], /var\(--upband, 0px\)/);
  assert.match(pane["mask-image"], /var\(--downband, 0px\)/);
});
