// The Mac pages' hover labels (hover-labels.js): how a label reads its name
// and key, where it stands for a control and when it moves under it, the
// outline its pointer is cut from, and the labels themselves, page by page.
// Browser-free: the pure parts of the file are run as they are, and the pages
// and sheets are read as text.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const L = require(path.join(ROOT, "hover-labels.js"));

const VIEW = { left: 0, top: 0, right: 1512, bottom: 982 };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("a label is its name, then its key in brackets when it has one", () => {
  assert.deepEqual(L.parse("Home (Cmd + 0)"), { name: "Home", key: "Cmd + 0" });
  assert.deepEqual(L.parse("Older Reply (Ctrl + Shift + Up)"), { name: "Older Reply", key: "Ctrl + Shift + Up" });
  assert.deepEqual(L.parse("Deferred (Ctrl + Shift + \\)"), { name: "Deferred", key: "Ctrl + Shift + \\" });
  assert.deepEqual(L.parse("Search Cards"), { name: "Search Cards", key: "" });
  assert.deepEqual(L.parse(null), { name: "", key: "" });
});

test("the label waits 600ms, rises over 160ms, and the next one comes at once for 450ms", () => {
  assert.equal(L.DELAY, 600);
  assert.equal(L.RISE, 160);
  assert.equal(L.WARM, 450);
  assert.equal(L.GAP, 3);
  assert.equal(L.POINTER, 6);
});

test("a label stands above its control, centred, with its pointer at the control's middle", () => {
  const icon = rect(700, 300, 32, 32);
  const p = L.place(icon, 120, 31, VIEW);
  assert.equal(p.side, "above");
  assert.equal(p.top, 300 - 3 - 31, "3px between the pointer's tip and the control");
  assert.equal(p.left, 716 - 60, "centred on the control");
  assert.equal(p.px, 60, "the pointer at the control's middle");
});

test("near the window's top it moves under the control, and near a side it stays 8px inside", () => {
  // the top bar's icons: no room above, so under, pointing up
  const bar = rect(1440, 11, 32, 32);
  const under = L.place(bar, 150, 31, VIEW);
  assert.equal(under.side, "below");
  assert.equal(under.top, 11 + 32 + 3);
  assert.equal(under.left + under.w, VIEW.right - 8, "kept 8px inside the right edge");
  assert.equal(under.px, 1456 - under.left, "the pointer still points at the control");
  // 4px of air at the top is enough
  assert.equal(L.place(rect(700, 38, 32, 32), 80, 31, VIEW).side, "above");
  assert.equal(L.place(rect(700, 37, 32, 32), 80, 31, VIEW).side, "below");
  // the left edge
  assert.equal(L.place(rect(2, 300, 20, 20), 100, 31, VIEW).left, 8);
  // with room on neither side it stays above
  assert.equal(L.place(rect(0, 10, 32, 960), 80, 31, VIEW).side, "above");
});

test("the outline is one path: the chip, its rounded corners and the pointer kept clear of them", () => {
  const down = L.bubble(100, 25, 6, 50, true, 8);
  assert.match(down, /^M8 0H92A8 8 0 0 1 100 8V17A8 8 0 0 1 92 25H56L51\.1 30\.1Q50 31 48\.9 30\.1L44 25H8/);
  const up = L.bubble(100, 25, 6, 50, false, 8);
  assert.match(up, /^M8 6H44L48\.9 \.9Q50 0 51\.1 \.9L56 6H92/);
  // a pointer asked for at the chip's very end stands just clear of the corner
  assert.match(L.bubble(100, 25, 6, 2, true, 8), /H8A8 8 0 0 1 0 17/);
  assert.match(L.bubble(100, 25, 6, 2, true, 8), /Q15 31 /);
});

// every label each page names, in the format the labels share: a name of one to
// three words, each capitalised, then the key in brackets with Cmd, Ctrl,
// Option and Shift written short and joined by " + "
const LABELS = {
  "index.html": ["Home (Cmd + 0)", "Projects", "Search Cards", "Mute Chime", "Unmute Chime", "Share Feedback",
    "Settings", "Doing And Docked", "Deferred And Done", "New Card (Cmd + T)", "Expand Box", "Close Box",
    "Close Project", "Stays Open", "Reopen Project", "New Page", "New Box", "Older Reply (Ctrl + Shift + Up)",
    "Newer Reply (Ctrl + Shift + Down)", "Attach File", "Send (Enter)", "Save Or Unsave", "Newest Message",
    "Remove File", "Parent Folder", "Back To Files", "Save File (Cmd + S)", "Delete Card", "Right Side",
    "Left Side", "Restore", "Hide Box", "Edit Goal", "Cycle Status", "Edit Task", "Previous Row",
    "Previous Card (Left)", "Next Card (Right)", "Next Row"],
  "card-logic.js": ["Doing (Ctrl + Shift + [)", "Docked (Ctrl + Shift + ])", "Deferred (Ctrl + Shift + \\\\)",
    "Done (Ctrl + Shift + Delete)", "Reduce Box (Escape)", "Expand Box"],
  "card-markdown.js": ["Copy Code"],
  "folder-picker.js": ["Back (Left)", "Forward", "List View", "Column View", "Parent Folder", "Go (Enter)",
    "Type Path", "Close (Escape)", "New Folder"],
  "home-widgets.js": ["Close (Escape)", "Another Look", "Download", "Download Chart"],
  "onboarding.html": ["Doing And Docked", "Deferred And Done", "Share Feedback", "Older Reply (Ctrl + Shift + Up)",
    "Newer Reply (Ctrl + Shift + Down)"],
  "page.html": ["Edit Layout", "Background Color", "Settings", "Send (Enter)", "Edit Goal", "Cycle Status",
    "Edit Task", "Previous Row", "Previous Card (Left)", "Next Card (Right)", "Next Row", "New Project",
    "New Box", "Done", "Deferred", "Remove To-Do"],
};
const NAME = /^[A-Z][A-Za-z-]*(?: [A-Z][A-Za-z-]*){0,2}$/;
const KEY = /^(?:(?:Cmd|Ctrl|Option|Shift) \+ )*(?:Enter|Escape|Delete|Left|Right|Up|Down|[A-Z0-9]|[[\]\\])$/;

test("every label is in the labels' format and is where it is said to be", () => {
  for (const [file, labels] of Object.entries(LABELS)) {
    const source = read(file);
    for (const label of labels) {
      const { name, key } = L.parse(label.replace(/\\\\/g, "\\"));
      assert.match(name, NAME, `${file}: "${label}" is not one to three capitalised words`);
      if (key) assert.match(key, KEY, `${file}: "${label}" does not write its key the short way`);
      assert.ok(source.includes('"' + label + '"'), `${file} does not name "${label}"`);
    }
  }
  // the page's dots are numbered: Board Page 1, Blank Page 2
  assert.match(read("index.html"), /dot\.dataset\.tip = \(p\.kind === "blank" \? "Blank Page " : "Board Page "\) \+ \(i \+ 1\);/);
});

test("no control on the Mac pages keeps a browser tooltip, and each keeps its aria-label", () => {
  for (const file of ["index.html", "page.html", "onboarding.html"]) {
    const html = read(file);
    // markup: no button or field carries a title, and a labelled one is named for
    // screen readers (the project pill by the project's name, which the script writes)
    assert.deepEqual(html.match(/<(?:button|input)\b[^>]*\stitle="[^"]*"/g) || [], [], `${file}: a control has a title`);
    for (const tag of html.match(/<[a-z]+\b[^>]*\sdata-tip="[^"]*"[^>]*>/g) || [])
      if (!tag.includes('id="projpill"'))
        assert.match(tag, /\saria-label="[^"]+"/, `${file}: ${tag.slice(0, 80)} has no aria-label`);
    // and the page loads the one script that draws the labels
    assert.ok(html.includes('<script src="/hover-labels.js"></script>'), `${file} does not load the labels`);
  }
  for (const file of ["card-logic.js", "card-markdown.js", "home-widgets.js"])
    assert.doesNotMatch(read(file), /\.title = "|\stitle="/, `${file} still sets a tooltip`);
  // the folder picker's only titles are the machines' names, which carry text the picker cuts short
  assert.deepEqual(read("folder-picker.js").match(/\stitle="/g).length, 2);
  // the phone has no pointer to rest and never loads them
  assert.ok(!read("m.html").includes("hover-labels.js"));
});

test("the label's look is the glass the mock chose, the same on every page, in Berkeley Mono or the board's mono", () => {
  const sheet = read("card-tokens.css"), page = read("page.html");
  const block = css => css.slice(css.indexOf(".hl-tip{"), css.indexOf(".hl-tip svg{"));
  const rules = block(sheet).replace(/\s+/g, " ");
  assert.equal(block(page).replace(/\s+/g, " "), rules, "page.html's copy of the look is not card-tokens.css's");
  assert.match(rules, /font:400 11\.5px\/15px "Berkeley Mono", "TX-02", "IBM Plex Mono", monospace/);
  assert.match(rules, /\.hl-tip \.hl-glass\{position:absolute; inset:0; --qn-tint:\.86; --qn-blur:16px; --qn-edge:2;/);
  assert.match(rules, /\.hl-tip\.above\{--from:translateY\(3px\)\} \.hl-tip\.below\{--from:translateY\(-3px\)\}/);
  assert.match(rules, /transition:opacity var\(--in, \.16s\) ease-out, transform var\(--in, \.16s\) cubic-bezier\(\.2,\.9,\.25,1\)/);
  assert.match(rules, /\.hl-tip \.hl-key\{color:var\(--sub\)\}/);
  assert.doesNotMatch(rules + read("hover-labels.js"), /#432BFF|--accent/i);
  // no font file of Berkeley Mono is shipped: it is asked for by name only
  assert.doesNotMatch(sheet + page + read("index.html"), /@font-face[^}]*Berkeley/i);
});
