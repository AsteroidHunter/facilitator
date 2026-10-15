// Deterministic unit tests for the line an empty card typing box shows
// (COMPOSE_LINES and the compose functions in card-logic.js): exactly the twenty
// chosen lines, a card's line drawn from its own shuffled bag so none comes back
// before all twenty have been shown, held until a send, saved in localStorage and
// restored, dropped for cards that are gone, and the pages wiring it to the card
// typing boxes and nowhere else.
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
const CARD_LOGIC = read("card-logic.js");

// one page load: a fresh sandbox over a storage map that outlives it, the way a
// browser's localStorage outlives a reload
function load(store = new Map(), { broken = false } = {}) {
  const sandbox = {
    document: { createElement: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: noop, body: el() },
    setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
    requestAnimationFrame: noop, console, navigator: {}, location: {},
    localStorage: broken
      ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
      : { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CARD_LOGIC, sandbox);
  const lines = vm.runInContext("COMPOSE_LINES", sandbox);
  return { sandbox, store, lines, math: vm.runInContext("Math", sandbox) };
}
const saved = store => JSON.parse(store.get("composelines"));
// a ta/field pair like a page's, to see what composeTurn does to it
const card = () => ({ ta: { placeholder: "" }, field: null });

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
  const { lines: LINES } = load();
  assert.deepEqual([...LINES], CHOSEN);
  assert.equal(new Set(LINES).size, 20);
  // every trailing ellipsis is the one character, after a space
  for (const line of LINES) if (line.includes("…")) assert.ok(line.endsWith(" …"), line);
  assert.ok(!LINES.some(line => line.includes("...")));
  // no line ends with a full stop
  for (const line of LINES) assert.ok(!line.endsWith("."), line);
});

test("twenty draws on a card give twenty different lines, and the next twenty do too", () => {
  for (let round = 0; round < 25; round++) {
    const { sandbox } = load();
    const shown = [sandbox.composeLine("m7")];
    for (let i = 0; i < 39; i++) shown.push(sandbox.composeNext("m7"));
    assert.ok(shown.every(line => CHOSEN.includes(line)));
    assert.equal(new Set(shown.slice(0, 20)).size, 20, `bag 1: ${shown.slice(0, 20).join(" | ")}`);
    assert.equal(new Set(shown.slice(20)).size, 20, `bag 2: ${shown.slice(20).join(" | ")}`);
  }
});

test("a new bag never opens with the line just shown", () => {
  // many bags, so the one in twenty that would have repeated is certain to come up
  const { sandbox } = load();
  let last = sandbox.composeLine("m1");
  for (let i = 0; i < 2000; i++) {
    const next = sandbox.composeNext("m1");
    assert.notEqual(next, last, `draw ${i}`);
    last = next;
  }
  // and the case forced: a shuffle that would end on the shown line is turned over
  const { sandbox: forced, store, math } = load(new Map([["composelines", JSON.stringify({ q: { line: 19, bag: [] } })]]));
  math.random = () => 0.9999999;   // leaves the shuffle as 0..19, dealt from the end: 19 first
  assert.equal(forced.composeLine("q"), CHOSEN[19]);
  assert.notEqual(forced.composeNext("q"), CHOSEN[19]);
  assert.equal(saved(store).q.bag.length, 19);
});

test("each card has its own bag", () => {
  const { sandbox, store } = load();
  sandbox.composeLine("m1"); sandbox.composeLine("m2");
  const two = saved(store).m2;
  for (let i = 0; i < 5; i++) sandbox.composeNext("m1");
  assert.deepEqual(saved(store).m2, two);
  assert.equal(saved(store).m1.bag.length, 14);
});

test("the line holds until a send", () => {
  const { sandbox, store } = load();
  const first = sandbox.composeLine("m5");
  const before = store.get("composelines");
  // reopening, switching cards, typing and deleting all just ask again
  for (let i = 0; i < 10; i++) {
    assert.equal(sandbox.composeLine("m5"), first);
    sandbox.composeLine("m6");
    assert.equal(sandbox.composeLine("m5"), first);
  }
  assert.equal(saved(store).m5.line, CHOSEN.indexOf(first));
  // only a send moves it, once per send
  const second = sandbox.composeNext("m5");
  assert.notEqual(second, first);
  assert.equal(sandbox.composeLine("m5"), second);
  assert.equal(sandbox.composeLine("m5"), second);
  assert.notEqual(store.get("composelines"), before);
});

test("saved state restores after a reload, bag and all", () => {
  const first = load();
  const a = first.sandbox.composeLine("m9");
  const b = first.sandbox.composeNext("m9");
  const seen = [a, b];
  // a reload: a new page over the same storage
  const second = load(first.store);
  assert.equal(second.sandbox.composeLine("m9"), b);
  // the bag carried over, so the rest of the twenty are all new
  for (let i = 0; i < 18; i++) seen.push(second.sandbox.composeNext("m9"));
  assert.equal(new Set(seen).size, 20, seen.join(" | "));
  // each device keeps its own: another storage has nothing of it
  const other = load();
  assert.equal(other.store.size, 0);
});

test("a card with nothing saved starts with a random draw", () => {
  const starts = new Set();
  for (let i = 0; i < 200; i++) {
    const { sandbox, store } = load();
    starts.add(sandbox.composeLine("m1244"));
    assert.equal(saved(store).m1244.bag.length, 19);
  }
  assert.ok(starts.size >= 15, `${starts.size} different first lines in 200`);
});

test("an entry that does not add up is replaced, not trusted", () => {
  for (const bad of ["not json", "[]", "null", JSON.stringify({ x: { line: 99, bag: [] } }),
    JSON.stringify({ x: { line: 3, bag: [3, 4] } }), JSON.stringify({ x: { line: 3, bag: [4, 4] } }),
    JSON.stringify({ x: { line: "3", bag: [] } }), JSON.stringify({ x: 5 })]) {
    const { sandbox, store } = load(new Map([["composelines", bad]]));
    assert.ok(CHOSEN.includes(sandbox.composeLine("x")), bad);
    assert.equal(sandbox.composeLine("x"), sandbox.composeLine("x"));
    assert.equal(saved(store).x.bag.length, 19, bad);
  }
});

test("a browser that will not keep it still holds the line within the page", () => {
  const { sandbox } = load(new Map(), { broken: true });
  const first = sandbox.composeLine("m3");
  assert.equal(sandbox.composeLine("m3"), first);
  const next = sandbox.composeNext("m3");
  assert.notEqual(next, first);
  assert.equal(sandbox.composeLine("m3"), next);
});

test("entries for cards that are gone are dropped, the rest stay", () => {
  const { sandbox, store } = load();
  for (const id of ["m1", "m2", "m3", "m4"]) sandbox.composeLine(id);
  const m2 = saved(store).m2;
  sandbox.composeKeep(new Set(["m2", "m4"]));
  assert.deepEqual(Object.keys(saved(store)).sort(), ["m2", "m4"]);
  assert.deepEqual(saved(store).m2, m2);
  // never growing without end: many cards made and deleted leave only the live ones
  for (let n = 100; n < 400; n++) { sandbox.composeLine("m" + n); sandbox.composeKeep(new Set(["m2", "m" + n])); }
  assert.equal(Object.keys(saved(store)).length, 2);
  // a card drawn again after it was dropped just starts fresh
  assert.ok(CHOSEN.includes(sandbox.composeLine("m1")));
});

test("a send turns the box's line, in the plain field and through the editor", () => {
  const { sandbox } = load();
  const plain = card();
  const was = sandbox.composeLine("m8");
  plain.ta.placeholder = was;
  sandbox.composeTurn("m8", plain);
  assert.notEqual(plain.ta.placeholder, was);
  assert.equal(plain.ta.placeholder, sandbox.composeLine("m8"));
  // with an editor standing in, the field is asked to refresh and the page leaves the plain field to it
  let refreshed = 0;
  const wearing = { ta: { placeholder: "kept" }, field: { refreshPlaceholder() { refreshed++; } } };
  sandbox.composeTurn("m8", wearing);
  assert.equal(refreshed, 1);
  assert.equal(wearing.ta.placeholder, "kept");
});

test("the card typing boxes show it and take a new one on a send, the onboarding box and titles do not", () => {
  const index = read("index.html"), phone = read("m.html");
  assert.equal(index.match(/ta\.placeholder = composeLine\(b\.id\);/g).length, 2);   // large and small card
  assert.equal(index.match(/placeholder: \(\) => composeLine\(b\.id\)/g).length, 2);
  assert.equal(phone.match(/ta\.placeholder = composeLine\(b\.id\);/g).length, 1);
  assert.equal(phone.match(/placeholder: \(\) => composeLine\(b\.id\)/g).length, 1);
  // a send takes the next line: the large card, the small card, the phone
  assert.equal(index.match(/composeTurn\(/g).length, 2);
  assert.equal(phone.match(/composeTurn\(/g).length, 1);
  // a reading of the board drops the entries of cards that are gone
  assert.equal(index.match(/composeKeep\(onBoard\)/g).length, 1);
  assert.equal(phone.match(/composeKeep\(onBoard\)/g).length, 1);
  assert.doesNotMatch(read("onboarding.html"), /composeLine|composeTurn|composeKeep|COMPOSE_LINES/);
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
