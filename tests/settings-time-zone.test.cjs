// The Mac settings page's time zone, in plain words: the stored zone id is
// shown with the browser's own name for it and its offset now, never with
// underscores and with no city. The function is read out of index.html and run as it is.
// No browser and no server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const MAC = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const start = MAC.indexOf("const zoneWords = zone => {");
const end = MAC.indexOf("// the picture in Profile", start);
assert.ok(start >= 0 && end > start, "zoneWords is not in the page");
const zoneWords = vm.runInNewContext("(" + MAC.slice(start + "const zoneWords = ".length, end).trim().replace(/;$/, "") + ")", { Intl, Date });

test("a zone reads as its name and its offset, with no city in brackets", () => {
  assert.match(zoneWords("America/Los_Angeles"), /^Pacific Time, UTC−[78]$/);
  assert.match(zoneWords("America/Phoenix"), /^Mountain (Standard )?Time, UTC−7$/);
  assert.match(zoneWords("Asia/Kolkata"), /^India Standard Time, UTC\+5:30$/);
  assert.doesNotMatch(zoneWords("America/Los_Angeles"), /[()]|Los Angeles/);
});

test("no zone shows an underscore, and the zone with no city or offset still reads", () => {
  for (const zone of ["America/Los_Angeles", "America/Argentina/Buenos_Aires", "America/Port_of_Spain", "UTC"]) {
    const words = zoneWords(zone);
    assert.ok(words && !words.includes("_"), `${zone}: ${words}`);
  }
  assert.equal(zoneWords("UTC"), "UTC");
  assert.equal(zoneWords("Etc/GMT+5"), "UTC−5");
});

test("nothing stored shows nothing, and a zone the browser cannot name shows its id without underscores", () => {
  assert.equal(zoneWords(null), "");
  assert.equal(zoneWords("Nowhere/Made_Up"), "Nowhere/Made Up");
});
