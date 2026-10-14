// A turn of the working spinner changes one character in one ticket, every
// 180ms, while the list is on show. With nothing round the ticket to stop it,
// that change laid out and painted the whole list, a 40 to 57ms frame on the
// Simulator, and the drawer's slides caught on it. Each ticket is contained in
// size and layout now, so the turn stays inside its own ticket. These checks
// read the page's sheets and run the real spinner code; no browser, so they
// prove what is written and touched, not the frames a phone paints.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ROOT = path.join(__dirname, "..");
const HTML = readFileSync(path.join(ROOT, "m.html"), "utf8");
const TOKENS = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");

// every rule of the phone page's sheets and the shared one, comments dropped
function rules(css){
  const out = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    const selectors = m[1].trim();
    if (selectors.startsWith("@")) continue;
    const decls = {};
    for (const part of m[2].split(";")){
      const at = part.indexOf(":");
      if (at > 0) decls[part.slice(0, at).trim()] = part.slice(at + 1).replace(/\s+/g, " ").trim();
    }
    out.push({ selectors: selectors.split(",").map(s => s.replace(/\s+/g, " ").trim()), decls });
  }
  return out;
}
const PAGE = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const ALL = [...rules(PAGE), ...rules(TOKENS)];
// the rule's subject, the last compound of a selector: the element it styles
const subject = selector => selector.split(/\s*[>+~]\s*|\s+/).pop();
const isRow = selector => { const s = subject(selector); return /(^|[^\w-])\.trow(?![\w-])/.test(s) && !s.includes("::"); };
const SIZING = /^(?:(?:min-|max-)?(?:height|width)|block-size|inline-size|aspect-ratio|flex(?:-basis|-grow|-shrink)?|align-self|display)$/;

test("a ticket is contained in size and layout, and never in paint", () => {
  const base = ALL.filter(r => r.selectors.length === 1 && r.selectors[0] === ".trow");
  assert.equal(base.length, 1, "one base ticket rule");
  assert.equal(base[0].decls.contain, "size layout");
  // paint containment would clip the keyboard pick's glass and the folded
  // corner, which both draw past the ticket's edge
  for (const r of ALL) for (const s of r.selectors){
    if (!isRow(s) || !("contain" in r.decls) || r === base[0]) continue;
    assert.fail(`${s} sets contain:${r.decls.contain}`);
  }
  assert.doesNotMatch(PAGE + TOKENS, /(?:^|[;{\s])contain\s*:\s*(?:strict|content|[^;}]*\bpaint\b)/);
});

test("nothing sizes a ticket by what it holds, so containing its size changes none", () => {
  const base = ALL.find(r => r.selectors.length === 1 && r.selectors[0] === ".trow");
  // a fixed height that does not grow or shrink in its column ...
  assert.equal(base.decls.height, "calc(52 * var(--u))");
  assert.equal(base.decls.flex, "none");
  // ... and the width of its section: a column whose rows stretch across it
  const pane = ALL.filter(r => r.selectors.some(s => subject(s) === ".tikpane"));
  assert.ok(pane.some(r => r.decls.display === "flex" && r.decls["flex-direction"] === "column"));
  for (const r of pane) assert.ok(!r.decls["align-items"] || /^(?:stretch|normal)$/.test(r.decls["align-items"]), "the section's rows must stretch");
  // no other rule on a ticket sets a size, so none can come from its words
  for (const r of ALL) for (const s of r.selectors){
    if (!isRow(s) || r === base) continue;
    const sized = Object.keys(r.decls).filter(p => SIZING.test(p));
    assert.deepEqual(sized, [], `${s} sizes a ticket`);
  }
});

test("a spinner turn writes only the glyph in its own ticket's age slot", () => {
  const from = LOGIC.indexOf("const SPIN_FRAMES"), to = LOGIC.indexOf("// ---- the card's own spinner");
  assert.ok(from > 0 && to > from, "the list's spinner code is where it was");
  const writes = [];
  // a ticket that lets the turn read its id and find its age slot, logs every
  // write, and has nothing else to call
  const ticket = (id, glyph) => {
    const age = new Proxy({ textContent: glyph }, { set(o, k, v){ writes.push([id, "age", k, v]); o[k] = v; return true; } });
    const dataset = new Proxy({ id }, { set(o, k, v){ writes.push([id, "dataset", k, v]); o[k] = v; return true; } });
    return new Proxy({ dataset, querySelector: sel => sel === ".tage" ? age : null, age },
      { set(o, k, v){ writes.push([id, "row", k, v]); o[k] = v; return true; } });
  };
  const rows = [ticket("a", "|"), ticket("b", "|")];
  let now = 1_000_000, tick = null;
  const context = vm.createContext({
    Date: { now: () => now },
    setInterval: fn => { tick = fn; return 1; }, clearInterval(){},
    lastState: { boxes: [{ id: "a", ts: 990 }, { id: "b" }, { id: "c", ts: 10 }] },
    ticketGreen: b => b.id !== "c",
    document: {
      querySelectorAll: sel => sel === "#tiklist .trow.working" ? rows : [],
      querySelector: sel => sel.startsWith("#tiklist .trow.working") ? (sel.includes(".tage") ? rows[0].age : rows[0]) : null,
    },
  });
  vm.runInContext(LOGIC.slice(from, to), context);
  vm.runInContext("syncSpinner()", context);
  assert.equal(typeof tick, "function", "the ticker runs while a ticket works");
  const frames = vm.runInContext("SPIN_FRAMES", context);
  const seen = { a: new Set(), b: new Set() };
  for (let i = 0; i < 8; i++){
    writes.length = 0;
    now += 180;
    tick();
    for (const [id, where, key, value] of writes){
      assert.equal(where, "age", `a turn wrote ${where}.${key} on ticket ${id}`);
      assert.equal(key, "textContent");
      assert.ok(frames.includes(value));
      seen[id].add(value);
    }
  }
  // both tickets turned through every frame, one character at a time
  assert.equal(seen.a.size, 4);
  assert.equal(seen.b.size, 4);
});
