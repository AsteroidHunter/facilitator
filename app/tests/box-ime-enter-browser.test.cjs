// An Enter that belongs to an input method sends nothing, in every typing row.
//
// Typing Japanese, Chinese or an accent through an input method, Enter confirms
// the words being built; it is not a send. Chrome hands the page that Enter with
// isComposing set. WebKit, which the phone app runs on, ends the composition
// first and hands it over with isComposing false and keyCode 229, the code for
// a key an input method has taken. The rows read only isComposing, so on the
// phone with a paired keyboard the Enter that confirmed a word sent the half
// written message, and the Mac board's small card read neither and sent on a
// plain composition Enter. The formatter's own Enter rule already reads both.
//
// Both kinds are played in a background tab of a browser that is already
// running (box-typing-fixture.cjs): a real composition through CDP, and the
// WebKit order as a raw key with keyCode 229 and no composition open.
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const F = require("./box-typing-fixture.cjs");
const { settle } = F;

const ROW = "article.box.sel textarea:not(.twin)";
let plain, formatted;

before(async () => {
  plain = await F.start({ formatted: false });
  formatted = await F.start({ formatted: true });
});
after(async () => {
  if (plain) await plain.stop();
  if (formatted) await formatted.stop();
});

// the two Enters an input method can hand a row, typed into whatever holds the
// caret: one inside an open composition, and WebKit's, after it has ended
async function imeEnters(page) {
  const cdp = await page.target().createCDPSession();
  await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await settle(60);
  await page.keyboard.press("Enter");
  await cdp.send("Input.insertText", { text: "日本" });
  await settle(60);
  const seen = [];
  await page.exposeFunction("__keySeen", e => seen.push(e)).catch(() => {});
  await page.evaluate(() => {
    if (window.__keyWatch) return;
    window.__keyWatch = true;
    addEventListener("keydown", e => window.__keySeen({ key: e.key, keyCode: e.keyCode, composing: e.isComposing }), true);
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await settle(500);
  await cdp.detach();
  return seen;
}

async function walk(fx, surface) {
  const id = await fx.card("IME " + surface + " " + Date.now().toString(36));
  const phone = surface === "phone";
  const { page, problems } = await fx.open(phone ? `/m?box=${id}` : "/", phone ? F.PHONE : F.DESKTOP,
    phone ? { fakeViewport: true } : {});
  try {
    if (phone) await F.pickPhone(page, id); else await F.pickDesktop(page, id);
    if (fx === formatted) await F.editorOn(page);
    await F.focusRow(page);
    await page.keyboard.type("half ");
    const seen = await imeEnters(page);
    const webkit = seen.find(e => e.keyCode === 229);
    assert.ok(webkit && webkit.key === "Enter" && !webkit.composing, "the WebKit Enter was played: " + JSON.stringify(seen));
    const row = await F.row(page);
    assert.deepEqual(await fx.sentTexts(id), [], surface + ": an input method's Enter sent the row");
    assert.match(row.value, /^half /, surface + ": the row lost its words");
    assert.ok(row.value.includes("日本"), surface + ": the confirmed words are in the row");
    // and a real Enter still sends what was written
    await page.keyboard.press("Enter");
    await settle(700);
    assert.equal((await fx.sentTexts(id)).length, 1, surface + ": Enter after the words did not send");
    assert.deepEqual(problems, []);
  } finally { await fx.close(page); }
}

for (const [label, pick] of [["plain", () => plain], ["formatted", () => formatted]]) {
  test(`${label}: the Mac board's row sends nothing on an input method's Enter`, () => walk(pick(), "mac"));
  test(`${label}: the phone's row on a paired keyboard sends nothing on an input method's Enter`, () => walk(pick(), "phone"));
}

// the feedback box keeps the card's Enter rule, and its Enter starts the send's
// count down. it wakes only for a profile with a name and an email, so the
// scratch board's profile is given an invented one
async function feedbackWalk(surface) {
  const fx = formatted;
  const fs = require("node:fs"), path = require("node:path");
  const file = path.join(fx.board.data, "profile.json");
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...profile, email: "owner@example.invalid", email_yes: false }));
  const id = await fx.card("IME feedback " + surface);
  const phone = surface === "phone";
  const { page, problems } = await fx.open(phone ? `/m?box=${id}` : "/", phone ? F.PHONE : F.DESKTOP,
    phone ? { fakeViewport: true } : {});
  // and a count that ran out would post nothing anywhere: the request is stopped here
  await page.setRequestInterception(true);
  page.on("request", req => {
    if (new URL(req.url()).pathname === "/feedback") req.abort("blockedbyclient"); else req.continue();
  });
  try {
    if (phone) {
      await F.pickPhone(page, id);
      await page.evaluate(() => {
        showMenu(settings);
        document.querySelector('#setpage .sp-item[data-section="improvements"]')?.click();
      });
    } else {
      await F.pickDesktop(page, id);
      await page.evaluate(() => document.getElementById("feedbackbtn").click());
    }
    await F.until(page, () => document.getElementById("fbbox").dataset.state === "idle", "the feedback box awake", 10000);
    await F.until(page, () => {
      const ta = document.getElementById("fbta");
      if (document.activeElement !== ta) ta.focus();
      return document.activeElement === ta;
    }, "the feedback box focused", 8000);
    await page.keyboard.type("feedback ");
    await imeEnters(page);
    const state = await page.evaluate(() => ({ state: document.getElementById("fbbox").dataset.state,
      value: document.getElementById("fbta").value }));
    assert.equal(state.state, "idle", surface + ": an input method's Enter started the feedback send");
    assert.ok(state.value.startsWith("feedback ") && state.value.includes("日本"), surface + ": " + state.value);
    assert.deepEqual(problems, []);
  } finally { await fx.close(page); }
}
test("the Mac board's feedback box starts no send on an input method's Enter", () => feedbackWalk("mac"));
test("the phone's feedback box starts no send on an input method's Enter", () => feedbackWalk("phone"));

test("the Mac board's small card sends nothing on an input method's Enter", async () => {
  const fx = plain;
  const id = await fx.card("IME small " + Date.now().toString(36));
  const { page, problems } = await fx.open("/", F.DESKTOP);
  try {
    await F.pickDesktop(page, id);
    // the small card is off the board until it is arranged onto it
    await F.until(page, cardId => !!miniEls[cardId], "the small card built", 10000, id);
    await page.evaluate(cardId => {
      document.getElementById("magic2").classList.remove("region-off");
      miniGo(cardId);
      renderMiniCards(lastState);
    }, id);
    await F.until(page, cardId => {
      const ta = miniEls[cardId].ta;
      if (document.activeElement !== ta) ta.focus();
      return document.activeElement === ta;
    }, "the small card's row focused", 8000, id);
    await settle(200);
    await page.keyboard.type("small ");
    await imeEnters(page);
    const value = await page.evaluate(cardId => miniEls[cardId].ta.value, id);
    assert.deepEqual(await fx.sentTexts(id), [], "an input method's Enter sent the small card's row");
    assert.ok(value.startsWith("small ") && value.includes("日本"), "the small card kept its words: " + value);
    await page.keyboard.press("Enter");
    await settle(700);
    assert.equal((await fx.sentTexts(id)).length, 1, "Enter after the words did not send");
    assert.deepEqual(problems, []);
  } finally { await fx.close(page); }
});
