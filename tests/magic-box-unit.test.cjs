// Where a card's magic box stands, worked out without a browser: as tall as the
// card, two thirds as wide in whole star cells, one cell to its right, every
// edge on a star line, and over the card's edge rather than off the frame when
// the window has no room. And the page's wiring, read from its source: the box
// is never one of the regions the fit, the layout or edit mode work on.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.MAGIC_BOX_SOURCE_ROOT || path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
function api() {
  const scope = vm.createContext({});
  vm.runInContext(read("magic-box.js"), scope);
  return scope.MagicBox;
}
const { CELL, place } = api();
const close = (a, b) => Math.abs(a - b) < 1e-6;
const onStarLine = x => close((x / CELL - 0.5) - Math.round(x / CELL - 0.5), 0);
// the card where a new board puts it (index.html --frame-*), in stage pixels
const CARD = { left: 1440 * 0.324, top: 900 * 0.0832, width: 1440 * 0.352, height: 900 * 0.832 };
const WIDE = { scale: 1, tx: 0, left: 25, right: 1415 };

test("beside the default card: as tall, two thirds as wide in whole cells, one cell to the right", () => {
  const at = place(CARD, WIDE);
  assert.ok(close(at.width, 29 * CELL), `width ${at.width}`);
  assert.ok(close(at.left, CARD.left + CARD.width + CELL));
  assert.deepEqual([at.top, at.height, at.floating], [CARD.top, CARD.height, false]);
  assert.ok(onStarLine(at.left) && onStarLine(at.left + at.width), "both side edges on star lines");
  assert.ok(at.left + at.width < 1440, "inside the 1440 stage");
});

test("a dragged or sized card takes its box with it", () => {
  const moved = { left: 8.5 * CELL, top: 3.5 * CELL, width: 30 * CELL, height: 50 * CELL };
  const at = place(moved, WIDE);
  assert.ok(close(at.width, 20 * CELL));
  assert.ok(close(at.left, moved.left + moved.width + CELL));
  assert.deepEqual([at.top, at.height, at.floating], [moved.top, moved.height, false]);
});

test("with no room on the right it floats over the card's edge, inside the frame, on a star line", () => {
  const narrow = { scale: 1, tx: 0, left: 25, right: 1175 };
  const at = place(CARD, narrow, 34);
  assert.equal(at.floating, true);
  assert.ok(at.left + at.width <= 1175 + 1e-6, "ends inside the frame");
  assert.ok(at.left < CARD.left + CARD.width && at.left > CARD.left, "over the card's right part");
  assert.ok(onStarLine(at.left));
  assert.ok(close(at.width, 29 * CELL), "the same size, never squeezed");
  assert.ok(at.top > CARD.top + 34 && at.top - (CARD.top + 34) < CELL, "starts just under the card's top bar");
  assert.ok(onStarLine(at.top), "on a star row");
  assert.ok(close(at.top + at.height, CARD.top + CARD.height), "and ends with the card");
  const beside = place(CARD, WIDE, 34);
  assert.deepEqual([beside.top, beside.height], [CARD.top, CARD.height], "beside the card the bar changes nothing");
});

test("the room is read through the stage's scale and shift, in both panes", () => {
  assert.equal(place(CARD, { scale: 0.8, tx: 20, left: 25, right: 1100 }).floating, false);   // (1100-20)/.8 = 1350
  assert.equal(place(CARD, { scale: 0.8, tx: 20, left: 25, right: 1060 }).floating, true);    // 1300 < 1319
  const pane = place(CARD, { scale: 0.9, tx: -300, left: 0, right: 1000 });                   // the right pane
  assert.equal(pane.floating, false);
});

test("in a window narrower than the box it never starts left of the frame", () => {
  const at = place(CARD, { scale: 1, tx: 0, left: 600, right: 700 });
  assert.equal(at.floating, true);
  assert.ok(at.left >= 600, `left ${at.left}`);
  assert.ok(onStarLine(at.left));
});

test("an agent's page gets the sealing policy first, before anything it wrote", () => {
  const { pageDoc, PAGE_POLICY, PAGE_SANDBOX, SITE_SANDBOX } = api();
  const doc = pageDoc('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src *"><script>1</script>');
  assert.ok(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">`));
  assert.ok(doc.indexOf(PAGE_POLICY) < doc.indexOf("default-src *"), "the agent's own policy comes after, so it can only narrow");
  for (const part of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
    "img-src data: blob:", "script-src 'unsafe-inline'"])
    assert.ok(PAGE_POLICY.includes(part), part);
  assert.ok(!/https?:|\*/.test(PAGE_POLICY), "the policy names no place on the network");
  assert.equal(pageDoc(null), pageDoc(""));
  // with a word, the page says it is still itself once it has loaded, right
  // after the policy and before the agent's own page; the word cannot close
  // the script it stands in
  const said = pageDoc("<p>x</p>", "magic-</script>x");
  assert.ok(said.indexOf(PAGE_POLICY) < said.indexOf("postMessage") && said.indexOf("postMessage") < said.indexOf("<p>x</p>"));
  assert.match(said, /addEventListener\("load", \(\) => parent\.postMessage\("magic-\\u003c\/script>x", "\*"\)\)/);
  // scripts and nothing else: never the board's origin, no forms, popups or top navigation
  assert.equal(PAGE_SANDBOX, "allow-scripts");
  assert.equal(SITE_SANDBOX, "allow-scripts allow-same-origin allow-forms");
  for (const flag of ["allow-popups", "allow-top-navigation", "allow-modals"]) assert.ok(!SITE_SANDBOX.includes(flag), flag);
});

test("the page builds its frames from those lists, and a site's frame carries no logins", () => {
  const html = read("index.html");
  assert.match(html, /frame\.setAttribute\("sandbox", MagicBox\.PAGE_SANDBOX\)/);
  assert.match(html, /frame\.srcdoc = MagicBox\.pageDoc\(html, page\.word\)/);
  assert.match(html, /frame\.setAttribute\("credentialless", ""\)/);
  assert.match(html, /frame\.setAttribute\("sandbox", MagicBox\.SITE_SANDBOX\)/);
  assert.equal((html.match(/frame\.setAttribute\("referrerpolicy", "no-referrer"\)/g) || []).length, 2);
});

test("the board's own policy holds nothing a sealed page would inherit and be stopped by", () => {
  // a srcdoc frame inherits the policy of the page it stands in. the board's
  // page carries only frame-ancestors, which a srcdoc page has no answer to be
  // checked against; a script or fetch directive here would silently stop
  // every agent page
  const server = read("server.py");
  const framing = server.slice(server.indexOf("def _unframeable("), server.indexOf("# -- the wire"));
  assert.match(framing, /frame-ancestors 'none'/);
  assert.ok(!/default-src|script-src|style-src|connect-src|img-src/.test(framing));
});

test("the page loads the box's script and keeps the box out of the regions", () => {
  const html = read("index.html");
  assert.match(html, /<script src="\/magic-box\.js"><\/script>/);
  assert.match(html, /<section id="magicbox">/);
  const fit = html.match(/const FIT_REGIONS = \[([^\]]*)\]/)[1];
  const regions = html.match(/const REGION_SEL = "([^"]*)"/)[1];
  assert.ok(!fit.includes("magicbox") && !regions.includes("magicbox"));
  assert.match(html, /MagicBox\.place\(/);
  assert.match(read("server.py"), /Route\("\/magic-box\.js", _static\("magic-box\.js"/);
  assert.match(read("tests/fixture-auth.cjs"), /'magic-box\.js'/);
});
