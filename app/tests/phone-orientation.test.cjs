// The phone app asks to stay in portrait when the phone is turned. The standard
// way for a web app to ask is the orientation member of its web app manifest, so
// this holds the manifest file to "portrait" and checks that both pages that can
// be added to a home screen, the board page and the sign-in page, link that
// file. The server sends the file's own orientation unchanged on both routes
// (the local one rewrites only the name). Whether an iPhone obeys the member is
// not something a test here can show. Nothing here opens a browser or a server.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = name => readFileSync(path.join(ROOT, name), "utf8");

test("the phone manifest asks for portrait", () => {
  const manifest = JSON.parse(read("m-manifest.json"));
  assert.equal(manifest.orientation, "portrait");
});

test("the board page and the sign-in page both link that manifest", () => {
  for (const name of ["m.html", "m-gate.html"]) {
    assert.match(read(name), /<link rel="manifest" href="\/m-manifest\.json">/, name);
  }
});
