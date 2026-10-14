// what the board writes beside its code and must never reach a commit: the
// half-written password file bridge_auth.py can leave behind, and the notes
// folders a lane whose folder is this checkout keeps inside it
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n");

test("a half-written password file is ignored", () => {
  const source = fs.readFileSync(path.join(ROOT, "bridge_auth.py"), "utf8");
  const prefix = source.match(/mkstemp\(prefix="([^"]+)"/);
  assert.ok(prefix, "bridge_auth.py no longer names its temporary file prefix");
  assert.ok(
    ignored.includes("/" + prefix[1] + "*"),
    `${prefix[1]}* is not in .gitignore`,
  );
});

test("a lane's notes folders inside the checkout are ignored", () => {
  for (const folder of ["/facilitator-internal/", "/facilitator-wiki/"])
    assert.ok(ignored.includes(folder), `${folder} is not in .gitignore`);
});
