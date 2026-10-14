// The attach button at the left of a card's typing box wears Feather's
// paperclip (MIT) on the Mac board, the phone and the onboarding page, drawn at
// the plus's 17px, 1.9 stroke, round caps and currentColor. The plus stays as
// the new-card plus under the Mac card and on the phone's new-card button.
// Source reads only: no browser, no board, no network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const MAC = read("index.html"), PHONE = read("m.html"), ONBOARDING = read("onboarding.html"), GATE = read("m-gate.html");

const FEATHER_PATH = "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48";
const DRAWN = p => '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + p + '"></path></svg>';
const PLUS_PATH = "M12 5v14M5 12h14";

const pages = { "the Mac board": MAC, "the phone": PHONE, "the onboarding page": ONBOARDING };

for (const [name, text] of Object.entries(pages)) {
  test(name + " draws the attach button as Feather's paperclip at the plus's size and weight", () => {
    const line = text.split("\n").find(l => /^\s*const CLIP_ICON = /.test(l));
    assert.ok(line, "CLIP_ICON is defined");
    assert.ok(line.includes("'" + DRAWN(FEATHER_PATH) + "'"), "the path is Feather's, unchanged, in the plus's svg");
    assert.equal((text.match(/clip\.innerHTML = /g) || []).length, 1, "one place fills the attach button");
    assert.match(text, /clip\.innerHTML = CLIP_ICON;/);
  });
}

test("the Mac board's new-card plus keeps its plus", () => {
  const line = MAC.split("\n").find(l => /^const PLUS_ICON = /.test(l));
  assert.ok(line.includes("'" + DRAWN(PLUS_PATH) + "'"));
  assert.match(MAC, /cardPlus\.innerHTML = PLUS_ICON;/);
});

test("the phone's bottom-row new-card button keeps its plus", () => {
  assert.match(PHONE, /<button id="tikadd"[^>]*><svg[^>]*><path d="M12 5v14M5 12h14"\/><\/svg><\/button>/);
  assert.doesNotMatch(PHONE, /PLUS_ICON/);
});

test("the gate page's sample typing box shows the paperclip too", () => {
  const box = GATE.slice(GATE.indexOf('<span class="clipbtn">'), GATE.indexOf('<div class="compose">'));
  assert.ok(box.includes(DRAWN(FEATHER_PATH)));
  assert.doesNotMatch(box, /M12 5v14/);
});

test("Feather is credited with its MIT licence line", () => {
  const notices = fs.readFileSync(path.join(__dirname, "..", "..", "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.match(notices, /## Feather icons/);
  assert.match(notices, /Feather is distributed under the MIT License/);
  assert.match(notices, /Copyright \(c\) 2013-2017 Cole Bemis/);
});
