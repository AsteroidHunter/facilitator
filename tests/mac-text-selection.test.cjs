// Source-only selection cascade checks. No browser, server or dependencies.
// Resolve the shipped user-select declarations over representative DOM paths,
// including specificity, source order and auto's parent-dependent used value.
// This does not simulate native pointer selection or the browser's Find UI.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
// Allows the same regression to run against an unmodified source snapshot.
const html = process.env.MAC_SELECTION_HTML
  ? fs.readFileSync(process.env.MAC_SELECTION_HTML, "utf8") : read("index.html");
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n") +
  read("card-tokens.css") + read("home-widgets.css");

function compound(selector) {
  const parts = selector.match(/\[[^\]]+\]|[#.][\w-]+|[\w-]+|\*/g) || [];
  assert.equal(parts.join(""), selector, `unsupported selection selector: ${selector}`);
  return parts;
}
function matchesPart(node, selector) {
  return compound(selector).every(part => {
    if (part === "*") return true;
    if (part[0] === ".") return node.classes.includes(part.slice(1));
    if (part[0] === "#") return node.id === part.slice(1);
    if (part[0] !== "[") return node.tag === part;
    const attr = /^\[([\w-]+)(?:="([^"]*)"( i)?)?\]$/.exec(part);
    assert.ok(attr, `unsupported attribute selector: ${part}`);
    const value = node.attrs[attr[1]];
    return value !== undefined && (attr[2] === undefined ||
      (attr[3] ? value.toLowerCase() === attr[2].toLowerCase() : value === attr[2]));
  });
}
function matches(node, parts) {
  if (!node || !matchesPart(node, parts.at(-1))) return false;
  if (parts.length === 1) return true;
  for (let parent = node.parent; parent; parent = parent.parent)
    if (matches(parent, parts.slice(0, -1))) return true;
  return false;
}
const rules = [];
function specificityOf(parts) {
  const tokens = parts.flatMap(compound);
  return [tokens.filter(t => t[0] === "#").length,
    tokens.filter(t => t[0] === "." || t[0] === "[").length,
    tokens.filter(t => /^[a-z]/i.test(t)).length];
}
function selectorsOf(selectors) {
  const group = /^(.*):is\(([^()]*)\)(.*)$/.exec(selectors.trim());
  if (!group) return selectors.trim().split(/\s*,\s*/).map(selector => ({ selector }));
  const expanded = group[2].split(/\s*,\s*/).map(s => group[1] + s + group[3]);
  // :is takes its most specific arm even when another arm matches.
  const specificity = expanded.map(s => specificityOf(s.trim().split(/\s+/))).sort(compare).at(-1);
  return expanded.map(selector => ({ selector, specificity }));
}
for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const declarations = [...body.matchAll(/(?:^|;)\s*((?:-webkit-)?user-select)\s*:\s*(\w+)(\s*!important)?/g)];
  if (!declarations.length) continue;
  for (const entry of selectorsOf(selectors)) {
    const { selector } = entry;
    const parts = selector.match(/(?:\[[^\]]*\]|[^\s])+/g);
    const specificity = entry.specificity || specificityOf(parts);
    for (const [, property, value, important] of declarations)
      rules.push({ parts, property, value, rank: [Number(!!important), ...specificity, rules.length] });
  }
}
function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function selection(node, property) {
  if (!node) return "text";
  const matching = rules.filter(rule => rule.property === property && matches(node, rule.parts));
  matching.sort((a, b) => compare(a.rank, b.rank));
  const value = matching.at(-1)?.value || "auto";
  if (value === "auto" || value === "inherit") return selection(node.parent, property);
  return value;
}
const body = { tag: "body", classes: ["focus"], attrs: {} };
function node(tag = "div", classes = "", parent = body, attrs = {}, id = "") {
  return { tag, classes: classes.split(" "), parent, attrs, id };
}
function check(element, value, name) {
  for (const property of ["user-select", "-webkit-user-select"])
    assert.equal(selection(element, property), value, `${name}: ${property}`);
}

test("ticket titles, age/offline labels and all three clock lines are unselectable", () => {
  const row = node("div", "trow"), inner = node("div", "trowin", row);
  for (const cls of ["ttl", "tage", "teng"]) {
    assert.ok(html.includes(`"${cls}"`), `shipped ticket class ${cls}`);
    check(node("span", cls, inner), "none", cls);
  }
  for (const id of ["ck-day", "ck-time", "ck-date"]) {
    assert.ok(html.includes(`id="${id}"`));
    check(node("div", "", node("div", "", body, {}, "clockbox"), {}, id), "none", id);
  }
});

test("tabs, sections, labels, headings and future interface text default to none", () => {
  for (const [tag, cls] of [["span", "chip"], ["button", "ptab"], ["button", "ptab tvb"], ["label", ""],
    ["h2", "title"], ["button", ""], ["div", "future-widget"]])
    check(node(tag, cls), "none", `${tag}.${cls}`);
});

test("conversation messages and replies retain selectable prose, links and code", () => {
  for (const cls of ["reply", "mreply", "answmsg"]) {
    const message = node("div", cls + " cardmd");
    check(message, "text", cls);
    for (const tag of ["p", "a", "strong", "code", "blockquote"])
      check(node(tag, "", node("p", "", message)), "text", `${cls} ${tag}`);
    check(node("pre", "codeblock", message), "text", `${cls} code block`);
    check(node("button", "", message), "none", `${cls} button`);
    const copy = node("button", "copybtn", node("div", "codeblockwrap", message));
    check(node("span", "", copy), "none", `${cls} copy button text`);
  }
});

test("inputs, composer and editable fields opt in under unselectable ancestors", () => {
  for (const tag of ["input", "textarea"]) check(node(tag), "text", tag);
  for (const value of ["", "true", "TRUE", "plaintext-only"]) {
    const field = node("div", "", body, { contenteditable: value });
    check(field, "text", `editable=${value}`);
    check(node("span", "", field), "text", `editable=${value} child`);
  }
  check(node("div", "", body, { contenteditable: "false" }), "none", "noneditable UI");
});

test("card titles are selectable only while renaming", () => {
  for (const cls of ["title", "mtitle"]) {
    const title = node("span", cls);
    check(title, "none", cls);
    title.attrs.contenteditable = "plaintext-only";
    check(title, "text", `${cls} renaming`);
    delete title.attrs.contenteditable;
    check(title, "none", `${cls} finished`);
  }
});

test("formatted composer and file editor content stays selectable, including read-only text", () => {
  for (const editable of ["true", "false"]) {
    const editor = node("div", "cm-editor");
    const content = node("div", "cm-content", editor, { contenteditable: editable });
    check(content, "text", `editor editable=${editable}`);
    check(node("span", "", node("div", "cm-line", content)), "text", "decorated editor text");
    check(node("div", "cm-gutters", editor), "none", "editor gutter");
  }
});

test("Command+A uses each editor's document and Command+F stays available", () => {
  const context = vm.createContext({ navigator: { platform: "MacIntel", vendor: "Apple Computer, Inc.",
    userAgent: "Macintosh", maxTouchPoints: 0 }, console });
  vm.runInContext(read("cm-markdown.js"), context);
  vm.runInContext(read("compose-format.js"), context);
  const C = vm.runInContext("CM6", context), api = vm.runInContext("ComposeFormat", context);
  const composer = api.freshState(C, { shellClass: "compose-test", changed() {} }, "Composer only", 3);
  // Execute the real file mount through state construction; stop before it
  // creates a DOM view. Both plain and Markdown branches carry the keymap.
  const start = html.indexOf("function fileNavMount(");
  const end = html.indexOf('\n  el.edit.textContent = "";', start);
  assert.ok(start > 0 && end > start);
  Object.assign(context, { window: { CM6: C }, mdAwake() {}, mdLayer: () => [] });
  vm.runInContext(html.slice(start, end) + "\nreturn state;\n}", context);
  const mount = vm.runInContext("fileNavMount", context);
  const fileStates = [true, false].map(plain => mount({ _filenav: {} }, "File only\nsecond line", false, null, plain));
  for (const original of [composer, ...fileStates]) {
    const binding = original.facet(C.keymap).flat().find(key => (key.mac || key.key) === "Mod-a");
    assert.ok(binding, "editor keeps its select-all binding");
    let state = original;
    assert.equal(binding.run({ get state() { return state; }, dispatch(spec) { state = state.update(spec).state; } }), true);
    assert.equal(state.selection.main.from, 0);
    assert.equal(state.selection.main.to, original.doc.length);
    assert.equal(state.doc.toString(), original.doc.toString());
  }
  const guardStart = html.indexOf("function chromeShortcutBlocked(e){");
  vm.runInContext(html.slice(guardStart, html.indexOf("\nfunction installChromeShortcutGuard", guardStart)), context);
  const blocked = vm.runInContext("chromeShortcutBlocked", context);
  for (const key of ["a", "f"])
    assert.equal(blocked({ key, code: `Key${key.toUpperCase()}`, metaKey: true }), false);
});
