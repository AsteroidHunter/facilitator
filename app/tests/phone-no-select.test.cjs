// Source-only check of what a long press can select on the phone page. No browser or server.
// It reads the rules the page loads, m.html's own sheet, then card-tokens.css, then
// home-widgets.css, and works out user-select and -webkit-touch-callout for
// representative elements by specificity, source order and inheritance. It does not
// press anything: the real press is the simulator proof in the job's report.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const phone = read("m.html");
const sheets = [...phone.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n") +
  read("card-tokens.css") + read("home-widgets.css");

const PROPS = ["user-select", "-webkit-user-select", "-webkit-touch-callout"];
function compound(selector) {
  const parts = selector.match(/\[[^\]]+\]|[#.][\w-]+|[\w-]+|\*/g) || [];
  assert.equal(parts.join(""), selector, `unsupported selector: ${selector}`);
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
function specificityOf(parts) {
  const tokens = parts.flatMap(compound);
  return [tokens.filter(t => t[0] === "#").length,
    tokens.filter(t => t[0] === "." || t[0] === "[").length,
    tokens.filter(t => /^[a-z]/i.test(t)).length];
}
function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
const rules = [];
for (const [, selectors, body] of sheets.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
  const declared = [...body.matchAll(/(?:^|;)\s*(-webkit-user-select|user-select|-webkit-touch-callout)\s*:\s*([\w-]+)/g)];
  if (!declared.length) continue;
  for (const selector of selectors.trim().split(/\s*,\s*/)) {
    // a state or a generated box does not change what its element can pick
    if (/:|::/.test(selector.replace(/\[[^\]]*\]/g, ""))) continue;
    const parts = selector.match(/(?:\[[^\]]*\]|[^\s])+/g);
    for (const [, property, value] of declared)
      rules.push({ parts, property, value, rank: [...specificityOf(parts), rules.length] });
  }
}
function used(node, property) {
  if (!node) return property === "-webkit-touch-callout" ? "default" : "text";
  const matching = rules.filter(r => r.property === property && matches(node, r.parts))
    .sort((a, b) => compare(a.rank, b.rank));
  const value = matching.at(-1)?.value || "auto";
  // user-select auto takes its parent's used value; the callout is inherited
  if (value === "auto" || value === "inherit") return used(node.parent, property);
  return value;
}
const html = { tag: "html", classes: [], attrs: {}, id: "" };
const body = { tag: "body", classes: [], attrs: {}, id: "", parent: html };
function node(tag, classes = "", parent = body, attrs = {}, id = "") {
  return { tag, classes: classes.split(" ").filter(Boolean), parent, attrs, id };
}
function chrome(element, name) {
  for (const property of PROPS) assert.equal(used(element, property), "none", `${name}: ${property}`);
}
function words(element, name) {
  for (const property of ["user-select", "-webkit-user-select"])
    assert.equal(used(element, property), "text", `${name}: ${property}`);
  assert.equal(used(element, "-webkit-touch-callout"), "default", `${name}: callout`);
}
const page = node("div", "", body, {}, "page");

test("the page's own sheet makes everything unselectable with no callout, and the shared sheets are untouched", () => {
  const own = [...phone.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
  assert.match(own, /html, body, button\{-webkit-user-select:none; user-select:none; -webkit-touch-callout:none\}/);
  assert.doesNotMatch(read("card-tokens.css"), /(?:^|[\n,}])\s*(?:html|body)\s*[,{][^{}]*user-select/, "no page-wide rule in the shared card sheet");
  assert.doesNotMatch(read("home-widgets.css"), /(?:^|[\n,}])\s*(?:html|body)\s*[,{][^{}]*user-select/);
  const mac = read("index.html");
  assert.match(mac, /body, button\{-webkit-user-select:none; user-select:none\}/, "the Mac keeps its own rule");
  assert.doesNotMatch(mac, /what a long press can pick/, "the Mac does not take the phone's block");
});

test("the ticket list is unselectable: rows, titles, ages, agent names, tabs and their arrows", () => {
  for (const cls of ["trow", "trowin", "ttl", "tage", "teng"]) assert.ok(phone.includes(`"${cls}`), `shipped class ${cls}`);
  const pane = node("div", "tikpane", node("div", "", node("div", "", node("aside", "", node("div", "", page, {}, "tikwin"), {}, "tickets"), {}, "tiklist"), {}, "tiksheet"));
  const row = node("div", "trow working", pane), inner = node("div", "trowin", row);
  chrome(row, "row");
  chrome(inner, "row inner");
  for (const cls of ["ttl", "tage", "teng"]) chrome(node(cls === "ttl" ? "div" : "span", cls, inner), cls);
  chrome(node("img", "omni-art", inner), "ticket art");
  const head = node("div", "", node("aside", "", node("div", "", page, {}, "tikwin"), {}, "tickets"), {}, "tikhead");
  const pair = node("div", "tikpair", node("div", "", node("div", "", head, {}, "tiklabels"), {}, "tiknames"));
  chrome(node("button", "ptab tvb on", pair, {}, "tv-todo"), "Doing tab");
  chrome(node("button", "ptab tvb", pair, {}, "tv-docked"), "Docked tab");
  chrome(node("button", "qn-glass tik-page back", head, {}, "tik-page-back"), "back arrow");
  chrome(node("button", "qn-glass tik-page", head, {}, "tik-page"), "forward arrow");
  chrome(node("div", "tiknote", pane), "list note");
});

test("the card's top bar and the bottom bar are unselectable", () => {
  const bar = node("div", "topbar", node("div", "box sel", node("div", "", node("main", "", page, {}, "pane"), {}, "cards")));
  const hist = node("div", "histctl", bar);
  chrome(bar, "top bar");
  chrome(node("span", "histpos", hist), "history position");
  for (const cls of ["histbtn older", "histbtn newer", "sunbtn", "dockbtn", "arcbtn", "xbtn"]) chrome(node("button", cls, bar), cls);
  const dock = node("nav", "", page, {}, "dock");
  chrome(dock, "bottom bar");
  for (const id of ["ticketsbtn", "projbtn", "plusbtn", "squidbtn"]) chrome(node("button", "dockbtn", dock, {}, id), id);
  chrome(node("span", "", node("button", "dockbtn", dock, {}, "projbtn"), {}, "projname"), "project name");
});

test("the project list, Home, Settings text, the box's bar and the startup screens are unselectable", () => {
  const menu = node("div", "qn-glass", body, {}, "projmenu");
  chrome(menu, "project list");
  chrome(node("span", "pname", node("button", "projrow on", node("div", "", menu, {}, "projlist"))), "project name");
  const home = node("section", "", node("main", "", page, {}, "pane"), {}, "home");
  chrome(node("span", "", node("span", "", node("div", "", home, {}, "homebrand"), {}, "homebrandcopy"), {}, "homeversion"), "Home version");
  const settings = node("aside", "", body, {}, "settings");
  chrome(node("label", "", node("div", "", settings, {}, "setpage")), "settings label");
  chrome(node("button", "mbclose", node("div", "mbbar", node("section", "magicbox", node("aside", "", page, {}, "tickets"), {}, "mbface"))), "box close");
  chrome(node("div", "", body, {}, "loading"), "startup curtain");
  chrome(node("div", "", body, {}, "serverdown"), "server-down screen");
  chrome(node("div", "", body, {}, "diagnostictoast"), "diagnostic toast");
});

test("the card's own words stay selectable with the callout kept: title, answer, his bubbles, the magic box", () => {
  const card = node("div", "box sel", node("div", "", node("main", "", page, {}, "pane"), {}, "cards"));
  words(node("span", "title", node("div", "head", card)), "title");
  const view = node("div", "replyview", node("div", "body", card));
  const reply = node("div", "reply cardmd", view);
  words(reply, "reply");
  for (const tag of ["p", "a", "strong", "code", "blockquote", "li", "img"]) words(node(tag, "", node("p", "", reply)), `reply ${tag}`);
  words(node("pre", "codeblock", node("div", "codeblockwrap", reply)), "code block");
  const stack = node("div", "answstack", node("div", "answclip", node("div", "answered more", node("div", "answwrap", view))));
  words(node("div", "answmsg cardmd", stack), "his message in a bubble");
  words(node("p", "", node("div", "answmsg cardmd arrive", stack)), "his message's paragraph");
  const mb = node("div", "mbbody", node("section", "magicbox", node("aside", "", page, {}, "tickets"), {}, "mbface"));
  words(node("div", "mbtext cardmd plain", mb), "magic box text");
  words(node("p", "", node("div", "mbtext cardmd", mb)), "magic box paragraph");
});

test("buttons and marks inside the words are still unselectable", () => {
  const msg = node("div", "answmsg cardmd", node("div", "answstack"));
  chrome(node("button", "", msg), "button in a bubble");
  // it carries no link or picture, so only its selection is written off; the callout stays the words'
  for (const property of ["user-select", "-webkit-user-select"])
    assert.equal(used(node("span", "answmark", msg), property), "none", `delivery mark: ${property}`);
  chrome(node("span", "", node("button", "copybtn", node("div", "codeblockwrap", node("div", "reply cardmd")))), "copy button");
  chrome(node("svg", "answchev", node("div", "answfoot", node("div", "answered more"))), "fold arrow");
});

test("every text field keeps its caret and selection: the reply box, the settings fields, the typed-formatting editor", () => {
  const compose = node("div", "compose", node("div", "bottombar", node("div", "box sel")));
  words(node("textarea", "", compose), "reply box");
  words(node("div", "cm-content", node("div", "cm-scroller", node("div", "cm-editor", node("div", "cffield", compose))), { contenteditable: "true" }), "formatted reply box");
  words(node("div", "cm-line", node("div", "cm-content", node("div", "cm-editor"), { contenteditable: "true" })), "formatted line");
  const settings = node("div", "", node("aside", "", body, {}, "settings"), {}, "setpage");
  for (const type of ["text", "password", "url", "search"]) words(node("input", "", settings, { type }), `settings ${type} field`);
  for (const value of ["", "true", "TRUE", "plaintext-only"]) {
    const field = node("span", "title", node("div", "head"), { contenteditable: value });
    words(field, `title being renamed (${value || "empty"})`);
    words(node("span", "", field), `renamed title child (${value || "empty"})`);
  }
  chrome(node("div", "", body, { contenteditable: "false" }), "a non-editable box");
});
