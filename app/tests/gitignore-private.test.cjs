// what the board writes and must never reach a commit: data/ at the top of the
// checkout, which holds all of it; the half-written password file
// bridge_auth.py can leave behind; the notes folders a lane whose folder is
// this checkout keeps inside it; and the board's files where a checkout from
// before data/ still has them at its top
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ignored = fs.readFileSync(path.join(ROOT, "..", ".gitignore"), "utf8").split("\n");

test("data/, where the board writes everything, is ignored whole", () => {
  assert.ok(ignored.includes("/data/"), "/data/ is not in .gitignore");
  // and nothing in the repository is tracked under it, so a pull can never
  // write over a file the board keeps there
  const tracked = execFileSync("git", ["-C", path.join(ROOT, ".."), "ls-files", "--", "data"], { encoding: "utf8" });
  assert.equal(tracked.trim(), "", "a file under data/ is tracked");
});

test("a half-written password file is ignored", () => {
  const source = fs.readFileSync(path.join(ROOT, "bridge_auth.py"), "utf8");
  const prefix = source.match(/mkstemp\(prefix="([^"]+)"/);
  assert.ok(prefix, "bridge_auth.py no longer names its temporary file prefix");
  assert.match(source, /AUTH_FILE = Path\(__file__\)\.resolve\(\)\.parent\.parent \/ "data" \/ "bridge-auth\.json"/,
    "the password file is not kept in data/");
  assert.ok(
    ignored.includes("/" + prefix[1] + "*"),
    `${prefix[1]}* is not in .gitignore where a checkout from before data/ has it`,
  );
});

test("a lane's notes folders inside the checkout are ignored", () => {
  for (const folder of ["/facilitator-internal/", "/facilitator-wiki/"])
    assert.ok(ignored.includes(folder), `${folder} is not in .gitignore`);
});

test("the board's files at the top of a checkout that has not moved them yet stay ignored", () => {
  // between a pull and the move, an older checkout still has these at its top,
  // and git status must not show them as new files there
  const { TOP_FILES, TOP_FOLDERS } = JSON.parse(execFileSync(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c",
    "import data_folder, json; print(json.dumps({'TOP_FILES': data_folder.TOP_FILES, 'TOP_FOLDERS': list(data_folder.TOP_FOLDERS)}))"],
    { cwd: ROOT, encoding: "utf8" }));
  for (const name of TOP_FILES) assert.ok(ignored.includes("/" + name), `/${name} is not in .gitignore`);
  for (const name of TOP_FOLDERS) assert.ok(ignored.includes("/" + name + "/"), `/${name}/ is not in .gitignore`);
  for (const name of ["/.venv/", "/server.lock", "/bridge-auth.lock", "/tests/node_modules/"])
    assert.ok(ignored.includes(name), `${name} is not in .gitignore`);
});
