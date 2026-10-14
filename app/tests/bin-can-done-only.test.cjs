// The garbage can shows only in the Done section and is the list's quiet grey.
// Browser-free: binCanRow is cut out of index.html and run with stand-ins.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function binCanRow(view) {
  const start = html.indexOf("function binCanRow(");
  const end = html.indexOf("\nfunction binCanShow(", start);
  assert.ok(start > 0 && end > start, "binCanRow is not in the page");
  const row = { getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 160 }) };
  const pane = { getBoundingClientRect: () => ({ top: 0, bottom: 800 }), querySelectorAll: () => [row] };
  const ctx = { FOCUS: true, lastState: {}, binCanRestUntil: 0, tikTravelIntent: null, tikSheetAnim: null, binCans: [],
    BIN_CAN_GAP: 8, BIN_CAN_REACH: 12, Date, curView: () => view,
    document: { body: { matches: () => false }, querySelector: () => pane } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx.binCanRow(80, 130);   // the paper just left of the row
}

test("no can in Doing, Docked or Deferred", () => {
  for (const view of ["todo", "docked", "deferred"]) assert.equal(binCanRow(view), null, view);
});

test("a can in Done, beside the ticket", () => {
  assert.ok(binCanRow("done"));
});

test("the can is the list's grey, not black", () => {
  const rule = /\.bincan\{[^}]*\}/.exec(html)[0];
  assert.match(rule, /color:var\(--sub\)/);
  assert.doesNotMatch(rule, /#1e1e1e|#000|accent|#432BFF/i);
  assert.match(html, /\.tmeta \.tage\{[^}]*color:var\(--sub\)/, "the age text still uses --sub");
});
