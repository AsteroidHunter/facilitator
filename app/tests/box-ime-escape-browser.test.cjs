// An Escape that belongs to an input method leaves the caret where it is.
//
// Escape takes the caret out of a typing row, and a second one lets go of the
// card. Typing through an input method, Escape cancels the word being built,
// and the page took that Escape as its own: the caret left the row with the
// unconverted word left in it. The feedback sheet and the Settings page closed
// on it the same way. Chrome sends that Escape with isComposing set; WebKit
// ends the composition first and sends keyCode 229 (box-ime-enter-browser has
// the same two for Enter). A plain Escape still does what it did.
//
// Played in a background tab of a browser that is already running
// (box-typing-fixture.cjs).
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const F = require("./box-typing-fixture.cjs");
const { settle } = F;

let plain, formatted;
before(async () => {
  plain = await F.start({ formatted: false });
  formatted = await F.start({ formatted: true });
});
after(async () => {
  if (plain) await plain.stop();
  if (formatted) await formatted.stop();
});

// an Escape inside an open composition, then one in WebKit's order, each
// pressed on whatever holds the caret; answers whether it was still there
async function imeEscapes(page, still) {
  const cdp = await page.target().createCDPSession();
  try {
    await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
    await settle(60);
    await page.keyboard.press("Escape");
    await settle(250);
    const composing = await page.evaluate(still);
    await cdp.send("Input.insertText", { text: "日本" });
    await settle(60);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await settle(250);
    return { composing, webkit: await page.evaluate(still) };
  } finally { await cdp.detach(); }
}

const rowFocused = () => ComposeFormat.focused(document.querySelector("article.box.sel textarea:not(.twin)"));

async function rowWalk(fx, surface) {
  const id = await fx.card("IME escape " + surface + " " + Date.now().toString(36));
  const phone = surface === "phone";
  const { page, problems } = await fx.open(phone ? `/m?box=${id}` : "/", phone ? F.PHONE : F.DESKTOP,
    phone ? { fakeViewport: true } : {});
  try {
    if (phone) await F.pickPhone(page, id); else await F.pickDesktop(page, id);
    if (fx === formatted) await F.editorOn(page);
    await F.focusRow(page);
    await page.keyboard.type("half ");
    const kept = await imeEscapes(page, rowFocused);
    assert.deepEqual(kept, { composing: true, webkit: true }, surface + ": an input method's Escape took the caret out of the row");
    // a plain Escape still leaves the row
    await page.keyboard.press("Escape");
    await settle(200);
    assert.equal(await page.evaluate(rowFocused), false, surface + ": a plain Escape no longer leaves the row");
    assert.deepEqual(problems, []);
  } finally { await fx.close(page); }
}

for (const [label, pick] of [["plain", () => plain], ["formatted", () => formatted]]) {
  test(`${label}: the Mac board's row keeps the caret on an input method's Escape`, () => rowWalk(pick(), "mac"));
  test(`${label}: the phone's row keeps the caret on an input method's Escape`, () => rowWalk(pick(), "phone"));
}

// the sheets the feedback box and the profile are typed in
test("the Mac board's feedback sheet and Settings stay open on an input method's Escape", async () => {
  const fx = plain;
  const fs = require("node:fs"), path = require("node:path");
  const file = path.join(fx.board.data, "profile.json");
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...profile, email: "owner@example.invalid", email_yes: false }));
  const id = await fx.card("IME escape sheets");
  const { page, problems } = await fx.open("/", F.DESKTOP);
  try {
    await F.pickDesktop(page, id);
    await page.evaluate(() => document.getElementById("feedbackbtn").click());
    await F.until(page, () => document.getElementById("fbbox").dataset.state === "idle", "the feedback box awake", 10000);
    await F.until(page, () => {
      const ta = document.getElementById("fbta");
      if (document.activeElement !== ta) ta.focus();
      return document.activeElement === ta;
    }, "the feedback box focused", 8000);
    const sheetOpen = () => document.body.classList.contains("setopen") && document.activeElement === document.getElementById("fbta");
    assert.deepEqual(await imeEscapes(page, sheetOpen), { composing: true, webkit: true },
      "an input method's Escape closed the feedback sheet");
    await page.keyboard.press("Escape");
    await settle(400);
    assert.equal(await page.evaluate(() => document.body.classList.contains("setopen")), false, "a plain Escape no longer closes the sheet");
    // Settings, typed in its name field
    await page.evaluate(() => document.getElementById("setbtn").click());
    await F.until(page, () => document.body.classList.contains("setopen"), "Settings open", 8000);
    await F.until(page, () => {
      const field = document.getElementById("setname");
      if (document.activeElement !== field) field.focus();
      return document.activeElement === field;
    }, "the name field focused", 8000);
    const settingsOpen = () => document.body.classList.contains("setopen");
    assert.deepEqual(await imeEscapes(page, settingsOpen), { composing: true, webkit: true },
      "an input method's Escape closed Settings");
    assert.deepEqual(problems, []);
  } finally { await fx.close(page); }
});
