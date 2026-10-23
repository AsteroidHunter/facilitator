// No garbage can while the ticket sheet slides between sections: a can placed
// beside a row still sliding in stayed behind on the ticket once the row came to
// rest (m1248). The can comes back when the slide finishes, with the pointer still.
// Browser-free: binCanRow and setView are cut out of index.html and run with stand-ins.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function cut(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start > 0 && end > start, from + " is not in the page");
  return html.slice(start, end);
}

function binCanRow(tikSheetAnim) {
  const row = { getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 160 }) };
  const pane = { getBoundingClientRect: () => ({ top: 0, bottom: 800 }), querySelectorAll: () => [row] };
  const ctx = { FOCUS: true, lastState: {}, binCanRestUntil: 0, tikTravelIntent: null, tikSheetAnim, binCans: [],
    BIN_CAN_GAP: 8, BIN_CAN_REACH: 12, Date, curView: () => "done",
    document: { body: { matches: () => false }, querySelector: () => pane } };
  vm.createContext(ctx);
  vm.runInContext(cut("function binCanRow(", "\nfunction binCanShow("), ctx);
  return { found: ctx.binCanRow(120, 130), row };   // the pointer on the ticket
}

test("no can while the sheet is still sliding", () => {
  assert.equal(binCanRow({ playState: "running" }).found, null);
});

test("a can once the sheet is at rest", () => {
  const { found, row } = binCanRow(null);
  assert.equal(found, row);
});

test("a section press places the can again when its slide finishes", () => {
  const heard = [];
  const ctx = {
    tikTravelIntent: null, tikSheetAnim: null, lastState: null, activeOwner: "facilitator", binCanFollow() {},
    setTicketViewOf: () => true, chooseTicketNames() {}, cancelAutoNext() {}, paintViewTabs() {}, apply() {},
    moveTicketSheet() { ctx.tikSheetAnim = { addEventListener: (type, fn) => heard.push([type, fn]) }; },
  };
  vm.createContext(ctx);
  vm.runInContext(cut("function setView(", "\n{\n"), ctx);
  ctx.setView("done");
  assert.deepEqual(heard, [["finish", ctx.binCanFollow]]);
});
