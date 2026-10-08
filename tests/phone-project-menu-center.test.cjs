// The phone's project list opens centred on the project pill. No browser or server.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const PHONE = fs.readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

function between(start, end) {
  const at = PHONE.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  const to = PHONE.indexOf(end, at + start.length);
  assert.ok(to > at, `missing ${end}`);
  return PHONE.slice(at, to);
}

const context = {};
vm.runInNewContext(between("function projMenuLeft(", "function centreProjMenu"), context);
const left = (...a) => context.projMenuLeft(...a);

test("the list's centre is the pill's centre when there is room", () => {
  assert.equal(left(187.5, 200, 16, 359), 87.5);
  assert.equal(left(150, 100, 16, 359) + 50, 150);
});

test("the list slides just inside the bar's side edges, never past them", () => {
  assert.equal(left(60, 200, 16, 359), 16);
  assert.equal(left(330, 200, 16, 359), 159);
  assert.equal(left(187.5, 400, 16, 359), 16);
});

test("opening centres the list and it grows from its middle", () => {
  const open = between("function openProjects(){", "function closeProjects");
  assert.match(open, /centreProjMenu\(\);/);
  const centre = between("function centreProjMenu(){", "function openProjects");
  assert.match(centre, /pill\.left \+ pill\.width \/ 2/);
  assert.match(between("  #projmenu{\n", "  }\n"), /transform-origin:50% 100%/);
});
