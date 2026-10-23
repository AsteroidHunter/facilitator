// The Mac settings page's time zone, in plain words: the stored zone id is
// shown with the browser's own name for it and its offset now, never with
// underscores and with no city. The function is read out of card-logic.js and run as it is.
// No browser and no server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// the shared settings code, which the Mac page and the phone's drawer both draw it with
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");
const start = LOGIC.indexOf("function settingsZoneWords(zone){");
const end = LOGIC.indexOf("\n}\n", start) + 3;
assert.ok(start >= 0 && end > start, "settingsZoneWords is not in card-logic.js");
const zoneWords = vm.runInNewContext(LOGIC.slice(start, end) + "\nsettingsZoneWords", { Intl, Date });

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
