// the quick note's card references, on their own: how "card 12", "card12" and
// "c12" are read out of a note's words, which card a figure names, and what one
// edit does to the note's attachment. pure functions from card-logic.js, loaded
// the way a page loads them, with no browser and no board. every card below is
// invented
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const noop = () => {};
const sandbox = {
  document: { createElement: () => ({}), getElementById: () => null, querySelector: () => null,
              querySelectorAll: () => [], addEventListener: noop, body: {} },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "card-logic.js"), "utf8"), sandbox);
const { quickNoteRef, quickNoteCard, quickNoteAttachStep, quickNotesByCard, quickNotesNewestFirst } = sandbox;

const BOXES = [
  { id: "m12", title: "Rope ladder" },
  { id: "m5", title: "Lantern shed" },
  { id: "m128", title: "Kettle drum" },
  { id: "0", title: "Standing note" },
  { id: "q", title: "Quick chat" },
  { id: "n1", title: "Seeded row" },
];

test("all three forms the owner named are read, in any case", () => {
  for (const [words, figure] of [
    ["card 12", "12"], ["card12", "12"], ["c12", "12"],
    ["Card 12", "12"], ["CARD12", "12"], ["C12", "12"],
    ["see card 128 for this", "128"], ["about c5, later", "5"], ["(c5)", "5"],
    ["first line\nc12 on the second", "12"], ["c12\n", "12"], ["ends with card 5", "5"],
    ["card\t12", "12"], ["card 5.", "5"], ["card 5?", "5"],
  ]) assert.equal(quickNoteRef(words), figure, JSON.stringify(words));
});

test("a figure inside a longer word or number is never a card", () => {
  for (const words of [
    "abc12", "arc12", "mac99", "epic123", "discard 5", "scard 5", "c12b", "card12x", "c12_",
    "12c", "cards 12", "cardc12", "c1.2", "card 1.5", "xc12", "c 12", "card", "c", "", "#12",
    "twelve", "c-12", "card -12",
  ]) assert.equal(quickNoteRef(words), null, JSON.stringify(words));
  assert.equal(quickNoteRef(null), null);
  assert.equal(quickNoteRef(undefined), null);
});

test("the first reference in the words is the one that counts", () => {
  assert.equal(quickNoteRef("c12 then card 5"), "12");
  assert.equal(quickNoteRef("abc12 then c5"), "5", "the word abc12 hides no card, the later c5 does");
});

test("a figure names the card the board numbers that way, and nothing else", () => {
  assert.equal(quickNoteCard(BOXES, "12").id, "m12");
  assert.equal(quickNoteCard(BOXES, "128").id, "m128");
  assert.equal(quickNoteCard(BOXES, "0").id, "0", "a seeded numeric id is its own figure");
  assert.equal(quickNoteCard(BOXES, "99"), null, "no card carries 99");
  assert.equal(quickNoteCard(BOXES, "1"), null, "n1 is a standing id with no figure");
  assert.equal(quickNoteCard(BOXES, ""), null);
  assert.equal(quickNoteCard(BOXES, null), null);
  // a seeded 12 and a made m12 both standing: the one made on the board is meant
  assert.equal(quickNoteCard([{ id: "12", title: "seeded" }, { id: "m12", title: "made" }], "12").id, "m12");
  assert.equal(quickNoteCard([{ id: "12", title: "seeded" }], "12").id, "12");
});

test("typing a reference attaches, and a reference to a card that does not exist is told apart", () => {
  assert.deepEqual({ ...quickNoteAttachStep("", "c12", null, BOXES) }, { attach: "m12" });
  assert.deepEqual({ ...quickNoteAttachStep("notes", "notes on card 5", null, BOXES) }, { attach: "m5" });
  assert.deepEqual({ ...quickNoteAttachStep("", "c99", null, BOXES) }, { missing: "99" });
  // a missing card leaves an attachment the note already has where it is
  assert.deepEqual({ ...quickNoteAttachStep("c12", "c99", "m12", BOXES) }, { missing: "99" });
});

test("a changed reference moves the note, a deleted one lets it go", () => {
  assert.deepEqual({ ...quickNoteAttachStep("c12", "c5", "m12", BOXES) }, { attach: "m5" });
  assert.deepEqual({ ...quickNoteAttachStep("see c12", "see ", "m12", BOXES) }, { detach: true });
});

test("only a change in the reference acts", () => {
  // words typed around an unchanged reference ask nothing
  assert.equal(quickNoteAttachStep("c12", "c12 and more", "m12", BOXES), null);
  // a note let go some other way while its words still name the card stays let go
  assert.equal(quickNoteAttachStep("c12", "c12 and more", null, BOXES), null);
  // a note attached some other way is not let go by words that never named it
  assert.equal(quickNoteAttachStep("plain words", "plainer words", "m5", BOXES), null);
  // and deleting a reference to a card the note is not on detaches nothing
  assert.equal(quickNoteAttachStep("c12", "", "m5", BOXES), null);
  // already on the card the words name: nothing to send
  assert.equal(quickNoteAttachStep("", "c12", "m12", BOXES), null);
});

test("the notes are listed newest first and grouped by the card they are on", () => {
  const notes = [
    { id: "qn1", card: "m12", updated: 10 }, { id: "qn2", card: null, updated: 30 },
    { id: "qn3", card: "m12", updated: 20 }, { id: "qn4", card: "m5", updated: 20 },
  ];
  assert.deepEqual(quickNotesNewestFirst(notes).map(n => n.id), ["qn2", "qn4", "qn3", "qn1"]);
  const byCard = quickNotesByCard(notes);
  assert.deepEqual(Object.keys(byCard).sort(), ["m12", "m5"]);
  // arrays made inside the page's realm are copied out before they are compared
  assert.deepEqual(Array.from(byCard.m12, n => n.id), ["qn3", "qn1"]);
  assert.deepEqual({ ...quickNotesByCard(undefined) }, {});
});

test("the helpers that only wrote words onto the note are gone with the words", () => {
  for (const name of ["quickNoteCardName", "quickNoteFirstLine", "quickNoteNoticeText"])
    assert.equal(typeof sandbox[name], "undefined", name + " is still defined");
});
