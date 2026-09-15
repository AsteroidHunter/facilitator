// The return key on the phone row, read against the surface the viewport is
// wearing. The rule: with the on-screen keyboard up the return key makes a new
// line and the square is what sends; with it down, which is a row typed on by
// hand off a paired keyboard, the return key sends.
//
// A paired keyboard puts the on-screen one away and raises only its accessory
// bar, so the viewport is obstructed by a small inset while the on-screen
// keyboard is not up. The other phone suites drive the keyboard fully down (no
// obstruction) or fully up (kb); this one pins the case in between, obstructed
// with a sub-floor inset and no kb, in both composer faces, so the return key's
// send over a paired keyboard is held even though no other suite walks it. The
// full keyboard (kb) is checked alongside, so the line it makes is held too.
//
// The harness is tests/compose-cdp-fixture.cjs: a browser that is already
// running, and every tab made in the background. Nothing here launches,
// activates or closes a browser.
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fixture = require("./compose-cdp-fixture.cjs");

const { PHONE, ROW, settle, until, card, clearLane, sentTexts, open,
        pickPhoneCard, editorOn, rowRead } = fixture;

// the page reads an obstruction at or past this many css px as the on-screen
// keyboard, and anything short of it as an accessory bar over a paired keyboard
const BAR_INSET = 60;     // an accessory toolbar alone: obstructed, under the soft floor
const FULL_INSET = 336;   // an on-screen keyboard with its bar: obstructed and kb

function phoneCard(setting) {
  const opts = { fakeViewport: true };
  if (setting != null) opts.setting = setting;
  return { viewport: PHONE, route: id => `/m?box=${id}`, pick: pickPhoneCard, opts };
}

async function openCard(setting) {
  await clearLane();
  const id = await card("Enter send " + Date.now().toString(36), "A reply to answer.");
  const surface = phoneCard(setting);
  const opened = await open(surface.route(id), surface.viewport, surface.opts);
  await surface.pick(opened.page, id);
  if (setting == null) await editorOn(opened.page);
  else await until(opened.page, () => document.querySelectorAll(".cffield").length === 0,
                   "the plain row to stand with no editor", 10000);
  return { ...opened, id };
}

// drive the fake viewport to a given obstruction, settle past the lift window,
// and read back the classes the page decided on
async function setInset(page, inset) {
  await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - inset);
  await settle(650);
  return page.evaluate(() => ({
    kb: document.body.classList.contains("kb"),
    obstructed: document.body.classList.contains("obstructed"),
    lifting: document.body.classList.contains("lifting"),
  }));
}

// focus the row, raise the given surface, type words, press return, and report
// what the board saw and what the row kept
async function pressReturn(page, id, inset, words) {
  const sends = [];
  const note = request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  };
  page.on("request", note);
  try {
    await page.focus(ROW);
    const cls = await setInset(page, inset);
    await page.focus(ROW);
    await page.keyboard.type(words);
    await settle(220);
    await page.keyboard.press("Enter");
    await settle(480);
    return { cls, sends: sends.length,
             server: (await sentTexts(id)).slice(-1)[0],
             row: (await rowRead(page)).payload };
  } finally {
    page.off("request", note);
  }
}

before(async () => { await fixture.start(); });
after(async () => { await fixture.stop(); });

const WORDS = "hold these words";

// ---- the return key while the on-screen keyboard is down --------------------

test("no obstruction, formatting on: the return key sends", async t => {
  const { page, problems, id } = await openCard(null);
  try {
    const r = await pressReturn(page, id, 0, WORDS);
    t.diagnostic(JSON.stringify(r));
    assert.equal(r.cls.kb, false, "a bare frame was read as the on-screen keyboard");
    assert.equal(r.cls.obstructed, false, "a bare frame was read as obstructed");
    assert.equal(r.sends, 1, "the return key did not send with the keyboard down");
    assert.equal(r.server, WORDS, "the board was sent something other than the row");
    assert.equal(r.row, "", "the row kept the words after the send");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("accessory bar only, formatting on: the return key sends", async t => {
  const { page, problems, id } = await openCard(null);
  try {
    const r = await pressReturn(page, id, BAR_INSET, WORDS);
    t.diagnostic(JSON.stringify(r));
    assert.equal(r.cls.obstructed, true, "the accessory bar was not read as obstructing");
    assert.equal(r.cls.kb, false, "the accessory bar was read as the on-screen keyboard");
    assert.equal(r.sends, 1, "the return key did not send over a paired keyboard");
    assert.equal(r.server, WORDS, "the board was sent something other than the row");
    assert.equal(r.row, "", "the row kept the words after the send");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("no obstruction, formatting off: the return key sends", async t => {
  const { page, problems, id } = await openCard("0");
  try {
    const r = await pressReturn(page, id, 0, WORDS);
    t.diagnostic(JSON.stringify(r));
    assert.equal(r.cls.kb, false, "a bare frame was read as the on-screen keyboard");
    assert.equal(r.sends, 1, "the return key did not send on the plain row");
    assert.equal(r.server, WORDS, "the board was sent something other than the row");
    assert.equal(r.row, "", "the plain row kept the words after the send");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("accessory bar only, formatting off: the return key sends", async t => {
  const { page, problems, id } = await openCard("0");
  try {
    const r = await pressReturn(page, id, BAR_INSET, WORDS);
    t.diagnostic(JSON.stringify(r));
    assert.equal(r.cls.obstructed, true, "the accessory bar was not read as obstructing");
    assert.equal(r.cls.kb, false, "the accessory bar was read as the on-screen keyboard");
    assert.equal(r.sends, 1, "the return key did not send on the plain row over a paired keyboard");
    assert.equal(r.server, WORDS, "the board was sent something other than the row");
    assert.equal(r.row, "", "the plain row kept the words after the send");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the return key while the on-screen keyboard is up ----------------------

test("keyboard up, formatting on: the return key makes a line and sends nothing", async t => {
  const { page, problems, id } = await openCard(null);
  try {
    const r = await pressReturn(page, id, FULL_INSET, WORDS);
    t.diagnostic(JSON.stringify(r));
    assert.equal(r.cls.kb, true, "the on-screen keyboard was not read as up");
    assert.equal(r.sends, 0, "the return key sent while the on-screen keyboard was up");
    assert.ok(r.row.startsWith(WORDS) && r.row.endsWith("\n"),
      "the return key did not make the row's own new line: " + JSON.stringify(r.row));
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("keyboard up, formatting off: the return key makes a line and sends nothing", async t => {
  const { page, problems, id } = await openCard("0");
  try {
    const r = await pressReturn(page, id, FULL_INSET, WORDS);
    t.diagnostic(JSON.stringify(r));
    assert.equal(r.cls.kb, true, "the on-screen keyboard was not read as up");
    assert.equal(r.sends, 0, "the return key sent while the on-screen keyboard was up");
    assert.ok(r.row.startsWith(WORDS) && r.row.endsWith("\n"),
      "the return key did not make the plain row's own new line: " + JSON.stringify(r.row));
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
