// Deterministic unit tests for the line an empty card typing box shows
// (COMPOSE_LINES and composeLine in card-logic.js): exactly the twenty chosen
// lines, one fixed line per card, different lines for cards made one after
// another, and the pages wiring it to the card typing boxes and nowhere else.
// Loaded in a sandbox with DOM stubs so it runs under node without a browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const noop = () => {};
const el = () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  dataset: {}, children: [], appendChild: noop, setAttribute: noop, addEventListener: noop });
const sandbox = {
  document: { createElement: el, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: el() },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
const LINES = vm.runInContext("COMPOSE_LINES", sandbox);
const { composeLine } = sandbox;

const CHOSEN = [
  "Make Opus 6 and no mistakes pls …",
  "Make me a billion dollar company …",
  "Who is JSON?",
  "It's SI not AI!",
  "You're absolutely right!",
  "Let's run some smoke tests?",
  "Delete the failing tests …",
  "Prove P = NP by lunch",
  "Cite a paper that agrees with me",
  "p < 0.05, make it happen …",
  "Explain my own code to me?",
  "Ignore all previous instructions …",
  "Do what I meant, not what I said …",
  "Uber, but for cats …",
  "Rename it final_v2_FINAL …",
  "Turn my spaghetti into lasagna …",
  "Fewer em dashes, more answers …",
  "Explain it like I'm a PM",
  "Reply in under 900 words?",
  "Make the error bars smaller …",
];

test("the list is exactly the twenty chosen lines", () => {
  assert.deepEqual([...LINES], CHOSEN);
  assert.equal(new Set(LINES).size, 20);
  // every trailing ellipsis is the one character, after a space
  for (const line of LINES) if (line.includes("…")) assert.ok(line.endsWith(" …"), line);
  assert.ok(!LINES.some(line => line.includes("...")));
  // no line ends with a full stop
  for (const line of LINES) assert.ok(!line.endsWith("."), line);
});

test("a card's line is one of the twenty and the same every time it is asked", () => {
  for (const id of ["m1", "m1244", "m999999", "q", "seed-a", "12", "", null, undefined]) {
    const first = composeLine(id);
    assert.ok(CHOSEN.includes(first), `${id} -> ${first}`);
    for (let i = 0; i < 5; i++) assert.equal(composeLine(id), first);
    assert.equal(composeLine(String(id ?? "")), first);
  }
});

test("cards made one after another show different lines", () => {
  for (const start of [1, 7, 1244, 40000]) {
    const run = Array.from({ length: 20 }, (_, k) => composeLine("m" + (start + k)));
    assert.equal(new Set(run).size, 20, `m${start}..m${start + 19}`);
  }
  // ids that are not board numbers still spread over the list
  const named = new Set(["alpha", "beta", "gamma", "delta", "omni", "notes", "inbox", "q"].map(composeLine));
  assert.ok(named.size >= 5, [...named].join(" | "));
});

test("the card typing boxes show it, the onboarding box and titles do not", () => {
  const index = read("index.html"), phone = read("m.html");
  assert.equal(index.match(/ta\.placeholder = composeLine\(b\.id\);/g).length, 2);   // large and small card
  assert.equal(index.match(/placeholder: \(\) => composeLine\(b\.id\)/g).length, 2);
  assert.equal(phone.match(/ta\.placeholder = composeLine\(b\.id\);/g).length, 1);
  assert.equal(phone.match(/placeholder: \(\) => composeLine\(b\.id\)/g).length, 1);
  assert.doesNotMatch(read("onboarding.html"), /composeLine|COMPOSE_LINES/);
  assert.doesNotMatch(phone, /twin\.placeholder/);
});

test("the grey is exactly #F0F0F0 at full opacity, never the accent", () => {
  for (const [name, rule] of [["index.html", /:is\(\.compose, \.mcompose\) textarea::placeholder,\s*:is\(\.compose, \.mcompose\) \.cffield \.cm-placeholder\{([^}]*)\}/],
                              ["m.html", /\.compose textarea::placeholder, \.compose \.cffield \.cm-placeholder\{([^}]*)\}/]]) {
    const body = rule.exec(read(name));
    assert.ok(body, `${name}: placeholder rule`);
    assert.match(body[1], /color:#F0F0F0;/);
    assert.match(body[1], /opacity:1;/);
    assert.doesNotMatch(body[1], /#432BFF|--accent|--bubble-fill|--sub/i);
  }
});
