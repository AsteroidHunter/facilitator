// The notes panel in the right toolbar's room: the quick notes as cards in two
// staggered columns under a search pill, a large button for a new note, and an
// editor each card opens into. Everything goes through the quick note routes;
// every note below is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

let fx;
const VIEW = { width: 1512, height: 982 };
const SEED = {
  title: "Notes panel fixture",
  items: [
    { id: "3", bucket: "meta", owner: "facilitator", title: "Upload queue retries" },
    { id: "7", bucket: "meta", owner: "facilitator", title: "Second screen budget" },
  ],
};
const NOTES = [
  ["Remember to water the basil", null],
  ["Milk\nEggs\nRye bread\nCoffee beans", null],
  ["Ask whether the retry backoff should cap at thirty seconds", "3"],
  ["Book the dentist, Tuesday or Thursday", null],
  ["Budget line for the second screen: under 400", "7"],
  ["Check the train times for Saturday", null],
];

before(async () => {
  fx = await launch({ seed: SEED });
  for (const [text, card] of NOTES){
    await fx.post("/quicknote/new" + (card ? "?card=" + card : ""), text);
    await new Promise(r => setTimeout(r, 12));
  }
});
after(async () => { if (fx) await fx.stop(); });

const notes = async () => (await (await fetch(fx.origin + "/quicknotes")).json()).notes;
// no motion running, and the editor's field taking typing again
const idle = page => page.waitForFunction(() => !np.moving && !(document.querySelector(".np-ta") || {}).readOnly &&
  document.getAnimations().every(a => a.playState === "finished" || a.playState === "idle"), { timeout: 8000 });

async function openPanel(page){
  await page.click("#tool-notes");
  await page.waitForFunction(n => document.querySelectorAll("#railnotes .np-card").length >= n, { timeout: 8000 },
    (await notes()).length);
  await idle(page);
}
const cardTexts = page => page.evaluate(() =>
  npOrder(np.notes).filter(npMatches).map(n => n.text));
const shownCards = page => page.evaluate(() =>
  [...document.querySelectorAll("#railnotes .np-card")].map(c => c.firstChild.textContent));

test("the panel lists every note, newest first, in two staggered columns", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    const all = await notes();
    const shown = await shownCards(page);
    assert.equal(shown.length, all.length, "one card per note");
    const newest = all.slice().sort((a, b) => b.updated - a.updated).map(n => n.text);
    assert.deepEqual(await cardTexts(page), newest, "cards run newest first");
    const g = await page.evaluate(() => {
      const room = document.getElementById("railnotes").getBoundingClientRect();
      const rel = el => { const r = el.getBoundingClientRect(); return { x: r.x - room.x, y: r.y - room.y, w: r.width, h: r.height }; };
      const card = document.querySelector("#railnotes .np-card");
      return { pill: rel(document.querySelector(".np-pill")), fab: rel(document.querySelector(".np-fab")),
        cols: [...document.querySelectorAll("#railnotes .np-col")].map(rel), room: { w: room.width, h: room.height },
        radius: getComputedStyle(card).borderRadius, pad: getComputedStyle(card).paddingLeft,
        text: document.getElementById("railnotes").innerText };
    });
    assert.equal(g.cols.length, 2, "two columns");
    assert.equal(g.cols[0].x, 8, "8 of margin on the left");
    assert.equal(g.cols[1].x - (g.cols[0].x + g.cols[0].w), 8, "8 between the columns");
    assert.equal(g.room.w - (g.cols[1].x + g.cols[1].w), 8, "8 of margin on the right");
    assert.equal(g.pill.h, 56, "the pill is 56 tall");
    assert.equal(g.fab.w, 80); assert.equal(g.fab.h, 80);
    assert.equal(g.room.w - (g.fab.x + g.fab.w), 16, "the button sits 16 from the right");
    assert.equal(g.room.h - (g.fab.y + g.fab.h), 16, "and 16 from the foot");
    assert.equal(g.radius, "12px"); assert.equal(g.pad, "16px");
    // staggered: the second card goes to the right column, and the two columns
    // do not share one row line all the way down
    const tops = await page.evaluate(() => [...document.querySelectorAll("#railnotes .np-col")]
      .map(c => [...c.children].map(x => Math.round(x.getBoundingClientRect().top))));
    assert.ok(tops[1].length > 0, "the right column holds cards");
    assert.notDeepEqual(tops[0], tops[1], "the columns keep their own heights");
    for (const word of ["Saved", "deleted", "No notes", "Undo"])
      assert.ok(!g.text.includes(word), "no status words: " + word);
  } finally { await context.close(); }
});

test("typing in the pill filters the cards, and clearing brings them back", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    const before = (await shownCards(page)).length;
    await page.click(".np-q");
    await page.keyboard.type("dentist");
    await idle(page);
    assert.deepEqual(await shownCards(page), ["Book the dentist, Tuesday or Thursday"]);
    // a note's attached card counts as its words too
    await page.evaluate(() => { const q = document.querySelector(".np-q"); q.value = "upload queue"; q.dispatchEvent(new Event("input")); });
    await idle(page);
    assert.deepEqual(await shownCards(page), ["Ask whether the retry backoff should cap at thirty seconds"]);
    await page.keyboard.press("Escape");   // the first Escape clears the words
    await idle(page);
    assert.equal(await page.evaluate(() => document.querySelector(".np-q").value), "");
    assert.equal((await shownCards(page)).length, before);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.rail), "notes", "the panel stays open");
  } finally { await context.close(); }
});

test("the layout switch shows one column and is kept across a reload", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    await page.click(".np-view");
    await idle(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#railnotes .np-col").length), 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#railnotes .np-card").length > 0, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll("#railnotes .np-col").length), 1, "still one column");
    await page.click(".np-view");
    await idle(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#railnotes .np-col").length), 2);
  } finally { await context.close(); }
});

test("a card opens into the editor, and what is typed there is saved", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    const target = (await notes()).find(n => n.text === "Remember to water the basil");
    await page.click(`#railnotes .np-card[data-id="${target.id}"]`);
    await idle(page);
    const ed = await page.evaluate(() => ({ open: document.querySelector(".np-ed").classList.contains("open"),
      value: document.querySelector(".np-ta").value, focused: document.activeElement === document.querySelector(".np-ta") }));
    assert.equal(ed.open, true, "the editor is open");
    assert.equal(ed.value, "Remember to water the basil");
    assert.equal(ed.focused, true, "the caret is in the words");
    await page.keyboard.type(" and the mint");
    await page.waitForFunction(async id => {
      const r = await fetch("/quicknotes"); const d = await r.json();
      return d.notes.find(n => n.id === id).text === "Remember to water the basil and the mint";
    }, { timeout: 5000 }, target.id);
    await page.keyboard.press("Escape");   // closes the note, not the panel
    await idle(page);
    assert.equal(await page.evaluate(() => document.querySelector(".np-ed").classList.contains("open")), false);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.rail), "notes");
    const first = (await shownCards(page))[0];
    assert.equal(first, "Remember to water the basil and the mint", "the edited note leads the list");
    assert.equal(await page.evaluate(id => document.activeElement.dataset.id, target.id), target.id,
      "focus is back on the note's card");
  } finally { await context.close(); }
});

test("delete asks nothing and removes the note; command Z writes it back", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    const target = (await notes()).find(n => n.text === "Check the train times for Saturday");
    await page.click(`#railnotes .np-card[data-id="${target.id}"]`);
    await idle(page);
    await page.click(".np-more");
    await idle(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll(".np-sheet .np-row")].map(r => r.textContent));
    assert.deepEqual(rows, ["Find in note", "Delete", "Make a copy"]);
    let dialogs = 0;
    page.on("dialog", d => { dialogs++; d.dismiss(); });
    await page.evaluate(() => [...document.querySelectorAll(".np-sheet .np-row")].find(r => r.textContent === "Delete").click());
    await idle(page);
    assert.equal(dialogs, 0, "no question is asked");
    assert.ok(!(await notes()).some(n => n.id === target.id), "the note is gone from the board");
    assert.ok(!(await shownCards(page)).includes(target.text), "and from the panel");
    assert.equal(await page.evaluate(() => document.querySelector(".np-ed").classList.contains("open")), false);

    await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
    await page.waitForFunction(t => [...document.querySelectorAll("#railnotes .np-card")].some(c => c.firstChild.textContent === t),
      { timeout: 5000 }, target.text);
    assert.ok((await notes()).some(n => n.text === target.text), "command Z writes it back as a note");
  } finally { await context.close(); }
});

test("a note attached to a card wears that card's name, and the chip goes to the card", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    const chips = await page.evaluate(() => [...document.querySelectorAll("#railnotes .np-card")]
      .map(c => ({ text: c.firstChild.textContent, chip: c.querySelector(".np-chip:not([hidden])")?.textContent || "" })));
    assert.equal(chips.find(c => c.text.startsWith("Ask whether")).chip, "Upload queue retries");
    assert.equal(chips.find(c => c.text.startsWith("Budget line")).chip, "Second screen budget");
    assert.equal(chips.find(c => c.text.startsWith("Book the dentist")).chip, "", "a note on no card has no chip");

    // a new note that names a card is attached to it through the quick note's own reading
    await page.click(".np-fab");
    await idle(page);
    await page.keyboard.type("Order the arm, card 7");
    await page.waitForFunction(async () => {
      const d = await (await fetch("/quicknotes")).json();
      const n = d.notes.find(x => x.text === "Order the arm, card 7");
      return n && n.card === "7";
    }, { timeout: 5000 });
    await page.keyboard.press("Escape");
    await idle(page);
    const fresh = await page.evaluate(() => {
      const c = [...document.querySelectorAll("#railnotes .np-card")].find(x => x.firstChild.textContent === "Order the arm, card 7");
      return c && c.querySelector(".np-chip:not([hidden])")?.textContent;
    });
    assert.equal(fresh, "Second screen budget");

    await page.evaluate(() => [...document.querySelectorAll("#railnotes .np-card .np-chip:not([hidden])")]
      .find(c => c.textContent === "Upload queue retries").click());
    await page.waitForFunction(() => selectedId === "3", { timeout: 4000 });
  } finally { await context.close(); }
});

test("keys typed in the panel stay out of the board's shortcuts", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await openPanel(page);
    await page.evaluate(() => { window.__boardKeys = 0; addEventListener("keydown", () => { window.__boardKeys++; }); });
    await page.click(".np-q");
    await page.keyboard.type("jk");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.evaluate(() => window.__boardKeys), 0, "the board heard none of it");
    await page.keyboard.press("Escape");   // clears the words
    await page.keyboard.press("Escape");   // leaves the pill for the room
    await page.keyboard.press("Escape");   // and the toolbar shuts the panel
    await page.waitForFunction(() => !document.documentElement.dataset.rail, { timeout: 4000 });
  } finally { await context.close(); }
});
