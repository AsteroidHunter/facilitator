// The page's copy of the curse word rules (curseWords, curseMask and
// sentCurseFree in card-logic.js) against the board's own (expletives.py):
// with "Replace curse words" on, a page works out a send's saved words at the
// press so its bubble can change in the air, and the board keeps the words it
// works out itself, so the two must never part. Both run here on the same list
// (the board's, as GET /expletives hands it over: expletives.page_rules) and
// the same words: invented sentences with curse words in every place the rules
// care about (links and addresses, markdown links, hyphens, joined words,
// capitals, repeated letters, endings, apostrophes, punctuation, letters of
// other scripts and numbers next to a word), and every character there is set
// against a curse word on each side, inside one, in a link and as white space,
// which is where the two languages' patterns could read a character
// differently. The board's answer is the one expected each time. No board and
// no browser is started; Python runs expletives.py as a child process.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test, after } = require("node:test");
const vm = require("node:vm");

const APP = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const noop = () => {};
const sandbox = {
  document: { createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(APP, "card-logic.js"), "utf8"), sandbox, { filename: "card-logic.js" });
const page = vm.runInContext("({ curseWords, curseMask, sentCurseFree, SENT_CURSES })", sandbox);

const work = mkdtempSync(path.join(tmpdir(), "curse-parity-"));
after(() => rmSync(work, { recursive: true, force: true }));
// the board's answers for a list of texts: how WordList.mask gives each
// (mask), how /send keeps each as a message's body, stripped and then masked
// (send), or each only stripped (strip)
function board(texts, how = "mask") {
  const input = path.join(work, "in.json"), output = path.join(work, "out.json");
  writeFileSync(input, JSON.stringify(texts));
  execFileSync(PYTHON, ["-B", "-c", `
import json, sys, expletives
texts = json.load(open(sys.argv[1], encoding="utf-8"))
how = sys.argv[3]
out = [t.strip() if how == "strip" else expletives.mask(t.strip() if how == "send" else t) for t in texts]
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
`, input, output, how], { cwd: APP, maxBuffer: 1 << 26 });
  return JSON.parse(readFileSync(output, "utf8"));
}
const RULES = JSON.parse(execFileSync(PYTHON, ["-B", "-c", "import json, expletives; print(json.dumps(expletives.page_rules()))"],
  { cwd: APP, encoding: "utf8" }));
const words = page.curseWords(RULES);

// where the two differ, the first place they do, to read
function firstDifference(texts, want, got) {
  for (let i = 0; i < texts.length; i++)
    if (want[i] !== got[i]) return { text: texts[i], board: want[i], page: got[i] };
  return null;
}

const SENTENCES = [
  // the user's own case and the frame check's sends
  "Fuck it", "that is so fucked", "this fucking build is slow again",
  "the shitty tests keep failing on the fucking phone build again today, every single time",
  // the examples the board promised
  "this is fucking broken, you ass, and unfuckingbelievable", "FUUUCK this phone, a classy assessment of shit",
  "spoken words: what the hell, un-fucking-believable", "a later message, still fucking broken", "the widget is shit",
  // capitals, repeats, endings, apostrophes
  "FUCK", "Fuck", "fUcK", "fuuuuuck", "ffffuuuucccckkkk", "SHIIIIT", "shitty", "shittier", "shittiest", "fuckers", "fuckery",
  "fucked", "fucks", "fuckin' hell", "fuckin’ hell", "fuck's sake", "for fuck’s sake", "fuckings", "assholes", "asses",
  // hyphens and joined words
  "un-fucking-believable", "unfuckingbelievable", "fuckface", "fuck-you", "motherfucking", "motherfucker",
  "bullshitters", "re-assess the ass", "half-assed", "dumbass", "jackass", "smartass-ery",
  // words only on their own, and normal words holding a root
  "you ass", "a classy assessment", "hello shell", "Hell!", "HELL?", "what the hell", "Scunthorpe", "cocked",
  "the cocktail", "Dickens", "assume", "passing grass", "shell-shocked", "hellish",
  // punctuation around a word
  "(shit)", "\"fuck\"", "'fuck'", "fuck.", "fuck,shit;damn", "*fuck*", "**fuck**ing", "_fuck_", "~fuck~", "#fuck", "@ass",
  "fuck!?", "...shit...", "<fuck>", "{ass}", "[ass]", "fuck/shit", "fuck\\shit", "fuck|shit",
  // links and addresses, left alone, and the words around them swapped
  "see https://example.com/fuck/this and fuck that", "HTTP://EXAMPLE.COM/FUCK then FUCK", "http://a.b/shit?x=fuck#ass",
  "/uploads/123-fuck.png fuck", "/UPLOADS/9-shit.mov shit", "a file /uploads/1-ass.txt, you ass",
  "httpſ://x.y/fuck fuck", "hxxp://x.y/fuck", "https:/x/fuck", "ftp://x/fuck",
  // markdown links: the target left alone, the words taking the escaped tag
  "[fuck you](https://x.y/fuck)", "[fuck](<a b fuck>)", "[shit](not a link fuck)", "![damn shit](/uploads/1-shit.png)",
  "\\[fuck](x)", "\\\\[fuck](x)", "[a [fuck] b](http://z)", "[x](y [fuck](z))", "fuck(you)", "[fuck](you)", "[fuck]",
  "[fuck] (x)", "[fuck](x", "[fuck](x) and [shit](y)", "[[fuck]](x)", "[fuck](a(b)c)", "[fuck](a\\)b)",
  // letters of other scripts and numbers beside a word
  "naïvefuck", "fuckß", "ßfuck", "日本fuck", "fuck日本", "Ωass", "assΩ", "fuck2", "2fuck", "ass2", "2ass", "ass²", "²ass",
  "ass½", "½ass", "assⅫ", "fucḱ", "assͅ", "ͅass", "😀fuck😀", "😀ass😀", "𝐟𝐮𝐜𝐤", "𝒂ss", "ass𝒂", "ass‍",
  // letters Python's IGNORECASE takes for a to z
  "shıt", "SHİT", "fucK", "aſſ", "ﬁ", "ﬀuck", "ǅamn",
  // white space of every kind
  "fuck it", "ass x", "\u0085ass", "\u001cass\u001f", "fuck\tit\nshit\r\nass", "fuck　ass", "ass﻿",
  // nothing to swap
  "", "hello", "a perfectly clean sentence with nothing in it", "https://example.com",
];

test("the page's rules give the board's words on every sentence", () => {
  assert.ok(words, "the page could not build the board's list into a pattern");
  const want = board(SENTENCES);
  const got = SENTENCES.map(text => page.curseMask(words, text));
  const diff = firstDifference(SENTENCES, want, got);
  assert.equal(diff, null, `the page and the board part: ${JSON.stringify(diff)}`);
  // and the cases the check rests on do swap
  assert.equal(got[0], "[expletive] it");
  assert.equal(got[SENTENCES.indexOf("[fuck you](https://x.y/fuck)")], "[\\[expletive\\] you](https://x.y/fuck)");
  assert.equal(got[SENTENCES.indexOf("/uploads/123-fuck.png fuck")], "/uploads/123-fuck.png [expletive]");
});

test("a send's saved words as the page works them out are the words /send keeps", () => {
  // /send keeps the body stripped as Python strips it, then masked; the page
  // works out nothing for a send the swap would not change
  page.SENT_CURSES.on = true;
  page.SENT_CURSES.words = words;
  try {
    const texts = [...SENTENCES, "  Fuck it  ", "\u001cfuck\u001c", "\ufefffuck\ufeff", "\u0085shit\u0085", "\n\nass\n",
      "\u3000clean words\u2028"];
    const kept = board(texts, "send"), stripped = board(texts, "strip");
    texts.forEach((text, i) => {
      const saved = page.sentCurseFree(text);
      if (saved === null) assert.equal(kept[i], stripped[i],
        `the page saw nothing to swap in ${JSON.stringify(text)} and the board kept ${JSON.stringify(kept[i])}`);
      else assert.equal(saved, kept[i], `the page worked out ${JSON.stringify(saved)} for ${JSON.stringify(text)}`);
    });
    // the switch off, or no list, works out nothing
    page.SENT_CURSES.on = false;
    assert.equal(page.sentCurseFree("Fuck it"), null);
    page.SENT_CURSES.on = true;
    page.SENT_CURSES.words = null;
    assert.equal(page.sentCurseFree("Fuck it"), null);
    // the Mac board's live switch, where it has one, is what counts
    page.SENT_CURSES.words = words;
    page.SENT_CURSES.switch = () => false;
    assert.equal(page.sentCurseFree("Fuck it"), null);
    page.SENT_CURSES.on = false;
    page.SENT_CURSES.switch = () => true;
    assert.equal(page.sentCurseFree("Fuck it"), "[expletive] it");
  } finally {
    Object.assign(page.SENT_CURSES, { on: false, words: null, switch: null });
  }
});

test("every character reads the same on both sides: as a letter beside a word, as a to z in any case, and as white space", () => {
  // one line for each character, set where the rules read the character next
  // to them: after and before a word matched only on its own, in the last and
  // middle letters of a root, doubled in one, and in a link, whose address
  // runs to white space. the board and the page each read the whole of each
  // text, and the answers are held line by line
  // a character that one side's Unicode tables do not have yet (Python's are
  // Unicode 16 here and Node's 17) is left out: each reads such a character
  // by the version it has, and no curse word is spelled with one
  const unassigned = new Set(JSON.parse(execFileSync(PYTHON, ["-B", "-c",
    "import json, sys, unicodedata; json.dump([c for c in range(0x110000) if unicodedata.category(chr(c)) == 'Cn'], sys.stdout)"],
    { cwd: APP, encoding: "utf8", maxBuffer: 1 << 26 })));
  const chars = [];
  for (let cp = 0; cp < 0x110000; cp++) {
    if ((cp >= 0xd800 && cp <= 0xdfff) || unassigned.has(cp)) continue;
    const c = String.fromCodePoint(cp);
    if (!/\p{Cn}/u.test(c)) chars.push(c);
  }
  const shapes = [
    c => "ass" + c, c => c + "ass", c => "fuc" + c, c => "sh" + c + "t", c => "a" + c + c, c => "http://a" + c + "fuck",
  ];
  for (const shape of shapes) {
    const text = chars.map(shape).join("\n");
    const [want] = board([text]);
    const got = page.curseMask(words, text);
    if (want === got) continue;
    const a = want.split("\n"), b = got.split("\n");
    const at = a.findIndex((line, i) => line !== b[i]);
    assert.fail(`the page and the board part on ${JSON.stringify(shape("X"))} with U+${chars[at].codePointAt(0).toString(16)}: ` +
      `board ${JSON.stringify(a[at])}, page ${JSON.stringify(b[at])}`);
  }
});

test("the page's rules come from the board's list alone: a list with other words swaps those", () => {
  // the list is handed over, not kept in the page: a list of one invented
  // root and one word on its own swaps exactly those, as the board's would
  const rules = { ...RULES, anywhere: ["blorp"], alone: ["zing"], never: ["zingaro"] };
  const mine = page.curseWords(rules);
  assert.equal(page.curseMask(mine, "Fuck it, blorpy BLOOORP zing zingaro zings unzing"),
    "Fuck it, [expletive] [expletive] [expletive] zingaro [expletive] unzing");
  assert.equal(page.curseWords({ ...RULES, anywhere: [], alone: [], never: [] }), null);
  assert.equal(page.curseWords(null), null);
});
