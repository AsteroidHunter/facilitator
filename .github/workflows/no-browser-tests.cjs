// Print the test files in app/tests that need no browser, one path per line
// from the top of the checkout, for .github/workflows/tests.yml.
//
//   node .github/workflows/no-browser-tests.cjs node     *.test.cjs and *.test.mjs
//   node .github/workflows/no-browser-tests.cjs python   test_*.py
//
// A file needs a browser when it loads puppeteer-core, names port 9222 (the
// shared background Chrome the CDP tests connect to), or loads a helper beside
// it in app/tests that does, followed through helpers of helpers. The choice
// is made from what each file contains, so a new test is picked up, or left
// out, without anyone editing a list.

const fs = require("node:fs");
const path = require("node:path");

const TOP = path.join(__dirname, "..", "..");
const TESTS = path.join(TOP, "app", "tests");
const BROWSER = /require\(\s*["']puppeteer-core["']\s*\)|from\s*["']puppeteer-core["']|import\(\s*["']puppeteer-core["']\s*\)|\b9222\b/;
const LOCAL = /(?:require\(|import\(|from)\s*["']\.\/([^"']+)["']/g;
const KINDS = {
  node: (name) => /\.test\.(cjs|mjs)$/.test(name),
  python: (name) => /^test_.*\.py$/.test(name),
};

const kind = KINDS[process.argv[2]];
if (!kind) {
  console.error("usage: node .github/workflows/no-browser-tests.cjs node|python");
  process.exit(2);
}

const files = new Set(fs.readdirSync(TESTS).filter((name) => /\.(cjs|mjs|js|py)$/.test(name)));
const text = new Map([...files].map((name) => [name, fs.readFileSync(path.join(TESTS, name), "utf8")]));
// the helpers each file loads with require("./x"), import("./x") or from "./x"
const loads = new Map([...files].map((name) => [name,
  [...text.get(name).matchAll(LOCAL)]
    .map((match) => [match[1], `${match[1]}.cjs`, `${match[1]}.js`, `${match[1]}.mjs`].find((n) => files.has(n)))
    .filter(Boolean)]));

// Start from the files that use a browser themselves, then add every file that
// loads one of them until nothing more is added.
const browser = new Set([...files].filter((name) => BROWSER.test(text.get(name))));
for (let grew = true; grew;) {
  grew = false;
  for (const [name, helpers] of loads) {
    if (!browser.has(name) && helpers.some((helper) => browser.has(helper))) {
      browser.add(name);
      grew = true;
    }
  }
}

for (const name of [...files].filter(kind).sort()) {
  if (!browser.has(name)) console.log(path.posix.join("app", "tests", name));
}
