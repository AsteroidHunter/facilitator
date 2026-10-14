const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// The copy button on a fenced block, on a phone. A touch screen has no hover to
// bring it up, so the shared sheet hides it at rest there and shows it, at a size
// a thumb can hit, while the page marks the block; the phone page copies the
// block's text when the button is tapped. The Mac keeps its hover rule and its
// own handler. No browser: the sheet is read as text, the copy runs against
// stand-in page objects, and the phone page's click handler is cut out of
// m.html by its own first line.
const ROOT = path.join(__dirname, "..");
const SHEET = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const MARKDOWN = readFileSync(path.join(ROOT, "card-markdown.js"), "utf8");
const PHONE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const BUTTON = ".cardmd .codeblockwrap .copybtn";

function declarations(body) {
  return Object.fromEntries(body.split(";").map(d => d.split(/:(.*)/s)).filter(d => d[1] !== undefined)
    .map(([name, value]) => [name.trim(), value.trim()]));
}
// the rules for one selector that sit at the top of the sheet, outside any @media
function plainRules(selector) {
  const outside = SHEET.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  return [...outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.trim() === selector).map(([, , body]) => declarations(body));
}
function touchRules(selector = BUTTON) {
  const media = [...SHEET.matchAll(/@media\s*\(\s*hover\s*:\s*none\s*\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)];
  return media.flatMap(([, inner]) => [...inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.trim() === selector).map(([, , body]) => declarations(body)));
}

test("the button stays hidden until hover where there is a mouse", () => {
  const [base] = plainRules(BUTTON);
  assert.equal(base.opacity, "0");
  assert.equal(base["pointer-events"], "none");
  const [hover] = plainRules(".cardmd .codeblockwrap:hover .copybtn");
  assert.equal(hover.opacity, "1");
  assert.equal(hover["pointer-events"], "auto");
});

test("on a touch screen the button rests hidden and cannot be hit, and a shown block brings it up", () => {
  assert.equal(touchRules().length, 1, "one hover: none rule for the button");
  assert.equal(touchRules()[0].opacity, undefined, "the base rule's hidden stands");
  assert.equal(touchRules()[0]["pointer-events"], undefined);
  const [stuck] = touchRules(".cardmd .codeblockwrap:hover .copybtn");
  assert.equal(stuck.opacity, "0", "a stuck hover brings nothing up");
  assert.equal(stuck["pointer-events"], "none");
  const [shown] = touchRules(".cardmd .codeblockwrap.copyshown .copybtn");
  assert.equal(shown.opacity, "1");
  assert.equal(shown["pointer-events"], "auto");
});

test("on a touch screen the tap area is at least 32 by 32 real pixels", () => {
  const [rule] = touchRules();
  for (const side of ["width", "height"]) {
    assert.match(rule[side] || "", /^\d+(\.\d+)?px$/, `${side} is stated in real pixels`);
    assert.ok(parseFloat(rule[side]) >= 32, `${side} is ${rule[side]}`);
  }
});

test("the touch rule changes nothing else about the button's look", () => {
  const [rule] = touchRules();
  assert.deepEqual(Object.keys(rule).sort(),
    ["height", "justify-content", "padding", "transition", "width"]);
  assert.ok(!/accent|purple/i.test(JSON.stringify(rule)));
});

// The simulator's WebKit paints a block that scrolls (the code) over an earlier
// positioned sibling, so the button, which comes first in the markup, sat under
// the code with nothing wrong in its computed style. It is raised above the
// code, in a stack of the wrapper's own, on touch screens only.
test("the button is raised above the code that scrolls, and no higher than its block, on the Mac and the phone", () => {
  const [button] = plainRules(BUTTON);
  assert.ok(parseInt(button["z-index"], 10) >= 1);
  const [wrap] = plainRules(".cardmd .codeblockwrap");
  assert.equal(wrap.isolation, "isolate");
  assert.equal(touchRules(".cardmd .codeblockwrap").length, 0, "no stacking of its own for touch");
});

// card-markdown.js run in a context of its own, with the page objects the copy
// reaches for. Each test says what the clipboard API does.
const COPY = '<svg class="copy"></svg>';
function page({ clipboard, execCommand = () => true }) {
  const timers = [], events = [];
  const code = { textContent: "const a = 1;\nconst b = 2;" };
  const button = { innerHTML: COPY, parentElement: { querySelector: sel => sel === "code" ? code : null } };
  const selection = {
    removeAllRanges: () => events.push("clear"), addRange: range => events.push(["select", range.of]),
  };
  const context = vm.createContext({
    navigator: clipboard === undefined ? {} : { clipboard },
    document: {
      createRange: () => ({ selectNodeContents(node) { this.of = node; } }),
      execCommand: command => { events.push(["exec", command]); return execCommand(command); },
    },
    getSelection: () => selection,
    setTimeout: (fn, ms) => { timers.push([fn, ms]); },
  });
  vm.runInContext(MARKDOWN, context);
  const api = vm.runInContext("CardMarkdown", context);
  return { api, button, code, timers, events };
}
const ticked = button => /M4 12\.5 10 18\.5 20 6/.test(button.innerHTML);

test("the clipboard API gets the block's text and the button shows a tick, then the icon again", async () => {
  const written = [];
  const p = page({ clipboard: { writeText: text => { written.push(text); return Promise.resolve(); } } });
  assert.ok(typeof p.api.copyCodeBlock === "function");
  await p.api.copyCodeBlock(p.button);
  assert.deepEqual(written, ["const a = 1;\nconst b = 2;"]);
  assert.ok(ticked(p.button));
  assert.deepEqual(p.events, [], "the page's own selection was left alone");
  assert.equal(p.timers.length, 1);
  assert.equal(p.timers[0][1], 1200);
  p.timers[0][0]();
  const icon = p.api.render("```\nx\n```").match(/<button[^>]*>(.*?)<\/button>/s)[1];
  assert.equal(p.button.innerHTML, icon);
});

test("with no clipboard API the block's text is selected, copied, and the selection dropped", async () => {
  const p = page({ clipboard: undefined });
  await p.api.copyCodeBlock(p.button);
  assert.deepEqual(p.events, ["clear", ["select", p.code], ["exec", "copy"], "clear"]);
  assert.ok(ticked(p.button));
});

test("a refused clipboard API falls back to selecting and copying", async () => {
  const p = page({ clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) } });
  await p.api.copyCodeBlock(p.button);
  assert.deepEqual(p.events, ["clear", ["select", p.code], ["exec", "copy"], "clear"]);
  assert.ok(ticked(p.button));
});

test("when neither way copies, the icon stays and nothing throws", async () => {
  const refused = page({ clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
    execCommand: () => false });
  await refused.api.copyCodeBlock(refused.button);
  assert.equal(refused.button.innerHTML, COPY);
  assert.deepEqual(refused.timers, []);
  const thrown = page({ clipboard: undefined, execCommand: () => { throw new Error("no"); } });
  await thrown.api.copyCodeBlock(thrown.button);
  assert.equal(thrown.button.innerHTML, COPY);
});

test("the phone page copies when a copy button is tapped and ignores every other tap", () => {
  const first = "// the copy button on a fenced block: a tap puts the block's text on the clipboard";
  const start = PHONE.indexOf(first);
  assert.ok(start >= 0 && PHONE.indexOf(first, start + 1) < 0, "the phone's copy handler moved");
  const source = PHONE.slice(start, PHONE.indexOf("\n});\n", start) + 5);
  const handlers = [], copied = [];
  vm.runInNewContext(source, {
    document: { addEventListener: (type, fn) => handlers.push([type, fn]) },
    CardMarkdown: { copyCodeBlock: button => copied.push(button) },
  });
  assert.deepEqual(handlers.map(h => h[0]), ["click"]);
  const button = { name: "copy" };
  handlers[0][1]({ target: { closest: sel => sel === ".copybtn" ? button : null } });
  handlers[0][1]({ target: { closest: () => null } });
  assert.deepEqual(copied, [button]);
});

test("the phone page loads the shared renderer that holds the copy", () => {
  assert.match(PHONE, /<script src="\/card-markdown\.js"><\/script>/);
});
