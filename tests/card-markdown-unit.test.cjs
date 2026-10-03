const assert = require("node:assert/strict");
const { test } = require("node:test");
const { performance } = require("node:perf_hooks");

const markdown = require("../card-markdown.js");

test("named and punctuation-adjacent links keep sentence punctuation outside", () => {
  const html = markdown.render(
    "See ([OpenAI](https://openai.com/docs)). " +
    "Also (https://example.com/a_(b)), then [local](/page?doc=1#x).",
  );
  assert.equal(html,
    '<p>See (<a href="https://openai.com/docs" target="_blank" rel="noopener">OpenAI</a>). ' +
    'Also (<a href="https://example.com/a_(b)" target="_blank" rel="noopener">' +
    'https://example.com/a_(b)</a>), then <a href="/page?doc=1#x" target="_blank" ' +
    'rel="noopener">local</a>.</p>');
});

test("inline subset formats emphasis, strike, code, images and escaped source", () => {
  const html = markdown.render(
    "*one* _two_ ~~gone~~ **bold** `**literal** <i>` " +
    "![plot](/uploads/plot.png) ![remote](https://example.com/plot.png) <script>x</script>",
  );
  assert.match(html, /<em>one<\/em> <em>two<\/em> <del>gone<\/del> <b>bold<\/b>/);
  assert.match(html, /<code class="inlinecode">\*\*literal\*\* &lt;i&gt;<\/code>/);
  assert.match(html, /<img class="shot" src="\/uploads\/plot\.png" alt="plot">/);
  assert.match(html, /!\[remote\]\(https:\/\/example\.com\/plot\.png\)/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test("URL policy rejects active and remote image targets", () => {
  assert.equal(markdown.escapeAttribute('"\''), "&quot;&#39;");
  assert.equal(markdown.safeLinkTarget('javascript:alert(1)'), null);
  assert.equal(markdown.safeLinkTarget('//evil.example/path'), null);
  assert.equal(markdown.safeLinkTarget('https://ok.example/\" onclick=\"x'),
    "https://ok.example/%22%20onclick=%22x");
  assert.equal(markdown.safeImageTarget("https://evil.example/x.png"), null);
  assert.equal(markdown.safeImageTarget("data:image/svg+xml,x"), null);
  assert.equal(markdown.safeImageTarget("/uploads/../secret.png"), null);
  assert.equal(markdown.safeImageTarget('/uploads/x.png\" onerror=\"x'),
    "/uploads/x.png%22%20onerror=%22x");
});

test("headings, rules, tables and indented code render as blocks", () => {
  const html = markdown.render(
    "## Heading *two*\n\n" +
    "| Name | Count |\n| :--- | ---: |\n| **A** | 2 |\n\n" +
    "    const x = '<tag>';\n    next();\n\n---",
  );
  assert.match(html, /^<h2>Heading <em>two<\/em><\/h2>/);
  assert.match(html, /<div class="tablewrap"><table><thead><tr>/);
  assert.match(html, /<th class="md-align-left">Name<\/th>/);
  assert.match(html, /<td class="md-align-right">2<\/td>/);
  assert.match(html, /<pre class="codeblock"><code>const x = &#39;&lt;tag&gt;&#39;;\nnext\(\);<\/code><\/pre>/);
  assert.match(html, /<hr>$/);
});

test("dash, plus, star and ordered lists support nesting and continuation", () => {
  const html = markdown.render(
    "- first\n  continued line\n  + nested one\n    continued nested\n  + nested two\n" +
    "- second\n\n* star\n* other\n\n3. three\n4. four",
  );
  assert.equal(html,
    "<ul><li><p>first<br>continued line</p><ul><li>nested one<br>continued nested</li>" +
    "<li>nested two</li></ul></li><li>second</li><li>star</li><li>other</li></ul>" +
    '<ol start="3"><li>three</li><li>four</li></ol>');
});

test("a numbered list names its widest number's digit count only past one digit", () => {
  const items = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}. item`).join("\n");
  assert.match(markdown.render(items(1, 9)), /^<ol><li>/);
  assert.match(markdown.render(items(1, 16)), /^<ol class="md-ol2"><li>/);
  assert.match(markdown.render(items(98, 102)), /^<ol start="98" class="md-ol3"><li>/);
  assert.match(markdown.render("- a\n- b"), /^<ul><li>/);
});

test("fences stay separate beside lists and quotes and expose a safe language label", () => {
  const html = markdown.render(
    "- before\n```js\" onmouseover=\"globalThis.pwned=1\nlet x = 1;\n```\n" +
    "> quote\n```py\nprint(1)\n```\n> after",
  );
  assert.match(html, /^<ul><li>before<\/li><\/ul><div class="codeblockwrap" /);
  assert.match(html, /data-language="js&quot; onmouseover=&quot;globalThis\.pwned=1"/);
  assert.match(html, /<span class="codelang">js&quot; onmouseover=&quot;globalThis\.pwned=1<\/span>/);
  assert.doesNotMatch(html, / onmouseover="/);
  assert.match(html, /<\/div><blockquote><p>quote<\/p><\/blockquote><div class="codeblockwrap" data-language="py">/);
  assert.match(html, /<\/div><blockquote><p>after<\/p><\/blockquote>$/);
});

test("ATX closing hashes require separating whitespace", () => {
  assert.equal(markdown.render("# C#\n\n# C #\n\n###\n\n# ###"),
    "<h1>C#</h1><h1>C</h1><h3></h3><h1></h1>");
  assert.equal(markdown.render("#C is not a heading"), "<p>#C is not a heading</p>");
});

test("table cells keep escaped pipes and pipes inside code spans", () => {
  const html = markdown.render(
    "| Value | Code |\n| --- | --- |\n| A \\| B | `x|y` |",
  );
  assert.match(html, /<td>A \| B<\/td>/);
  assert.match(html, /<td><code class="inlinecode">x\|y<\/code><\/td>/);
  assert.equal((html.match(/<td/g) || []).length, 2);
});

test("table rows preserve supplied cells beyond the header width", () => {
  const html = markdown.render(
    "| One | Two |\n| --- | --- |\n| alpha | beta | gamma | delta |",
  );
  assert.deepEqual(
    [...html.matchAll(/<td(?: [^>]*)?>(.*?)<\/td>/g)].map(match => match[1]),
    ["alpha", "beta", "gamma", "delta"],
  );
});

test("sparse tables render only supplied cells with bounded output", () => {
  const short = markdown.render(
    "| Left | Center | Right |\n| :--- | :---: | ---: |\n| one | two |",
  );
  assert.match(short,
    /<tbody><tr><td class="md-align-left">one<\/td><td class="md-align-center">two<\/td><\/tr><\/tbody>/);
  assert.doesNotMatch(short, /<td class="md-align-right"><\/td>/,
    "a missing trailing value manufactured a blank cell");

  const width = 2000;
  const rows = 2000;
  const header = "| " + Array.from({ length: width }, (_, index) => `c${index}`).join(" | ") + " |";
  const divider = "| " + Array.from({ length: width }, () => "---").join(" | ") + " |";
  const body = Array.from({ length: rows }, (_, index) => `| r${index} |`).join("\n");
  const started = performance.now();
  const html = markdown.render(header + "\n" + divider + "\n" + body);
  const elapsed = performance.now() - started;
  assert.equal((html.match(/<th(?:\s|>)/g) || []).length, width);
  assert.equal((html.match(/<td(?:\s|>)/g) || []).length, rows);
  assert.ok(html.length < 250000, `sparse table expanded to ${html.length} bytes`);
  assert.ok(elapsed < 3000, `sparse table took ${elapsed.toFixed(1)}ms`);
});

test("malformed brackets, link parentheses, and deep quotes stay bounded and visible", () => {
  const unmatchedBrackets = "[".repeat(40000) + "tail";
  const unmatchedTargets = "[x](".repeat(20000) + "tail";
  const trailingParens = "https://example.com/path" + ")".repeat(40000);
  const deepQuote = "> ".repeat(5000) + "tail";
  const started = performance.now();

  assert.equal(markdown.render(unmatchedBrackets), "<p>" + unmatchedBrackets + "</p>");
  assert.equal(markdown.render(unmatchedTargets), "<p>" + unmatchedTargets + "</p>");
  assert.equal(markdown.render(trailingParens),
    '<p><a href="https://example.com/path" target="_blank" rel="noopener">' +
    "https://example.com/path</a>" + ")".repeat(40000) + "</p>");
  const quoted = markdown.render(deepQuote);
  assert.match(quoted, /tail/);
  assert.equal((quoted.match(/<blockquote>/g) || []).length, 32);
  assert.ok(quoted.includes("&gt; ".repeat(5000 - 32) + "tail"),
    "depth guard discarded the unparsed quote text");
  assert.ok(performance.now() - started < 3000, "malformed input took too long");
});
