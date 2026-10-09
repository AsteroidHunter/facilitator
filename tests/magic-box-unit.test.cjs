// Where a card's magic box stands, worked out without a browser: at full size
// nine tenths of the card's height and 1.14 times the width of an iPhone 13
// mini screen as tall as the card, smaller when the room right of the card is
// short, in the middle of that room so the gap to the card and the gap to the
// workspace's edge are equal, level with the card's middle, and over the card's
// edge rather than off the workspace when the window has no room. Its look,
// read from the page's source: what it holds and the ticket list's two soft
// ends, no bar, no edge, no face. And the page's wiring: the box is never one of
// the regions the fit, the layout or edit mode work on.
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
const { CELL, TALL, WIDE, SHAPE, place } = api();
const PHONE = 375 / 812;
const close = (a, b, by = 1e-6) => Math.abs(a - b) < by;
// the card where a new board puts it (index.html --frame-*), in stage pixels
const CARD = { left: 1440 * 0.324, top: 900 * 0.0832, width: 1440 * 0.352, height: 900 * 0.832 };
const RIGHT = c => c.left + c.width;
const MIDDLE = r => r.top + r.height / 2;
// the workspace in a window w wide, as magicPlace hands it over: the frame's
// inner edges 6.5px in from the window's sides, the stage centred while the
// window is wider than it, and the fit's clearance of 16 as the least gap
const fitAt = (w, more = {}) => ({ scale: 1, tx: Math.max(0, (w - 1440) / 2), left: 6.5, right: w - 6.5, clear: 16, ...more });
const edgeOf = fit => (fit.right - fit.tx) / fit.scale;
// a box beside its card: its own shape, the two gaps equal, the middles level
function besideRight(at, card, fit) {
  const gapCard = at.left - RIGHT(card), gapEdge = edgeOf(fit) - (at.left + at.width);
  assert.equal(at.floating, false);
  assert.ok(close(at.width / at.height, SHAPE), `shape ${at.width / at.height}`);
  assert.ok(close(gapCard, gapEdge), `gaps ${gapCard} and ${gapEdge}`);
  assert.ok(gapCard >= fit.clear / fit.scale - 1e-6, `gap ${gapCard} under the clearance`);
  assert.ok(close(MIDDLE(at), MIDDLE(card)), `middle ${MIDDLE(at)} against ${MIDDLE(card)}`);
  assert.ok(at.height <= TALL * card.height + 1e-6, "never taller than nine tenths of the card");
  return gapCard;
}

test("the shape: an iPhone 13 mini screen as tall as the card, 5% off each end, 7% wider each side", () => {
  assert.equal(TALL, 0.9);
  assert.ok(close(WIDE, PHONE * 1.14));
  assert.ok(close(SHAPE, PHONE * 1.14 / 0.9));
  // no size of its own: a card twice as tall, with room for it, has a box twice as big
  const tall = place({ ...CARD, height: CARD.height }, fitAt(3000));
  const half = place({ ...CARD, height: CARD.height / 2 }, fitAt(3000));
  assert.ok(close(tall.width, 2 * half.width) && close(tall.height, 2 * half.height));
});

test("in the Mac's 1512 window: nine tenths of the card's height, 1.14 times the phone's width", () => {
  const fit = fitAt(1512);
  const at = place(CARD, fit, 34);
  const phone = { height: CARD.height, width: CARD.height * PHONE };   // the box as it was
  assert.ok(close(at.height / phone.height, 0.9), `height ${at.height / phone.height}`);
  assert.ok(close(at.width / phone.width, 1.14), `width ${at.width / phone.width}`);
  assert.ok(close(at.top - CARD.top, 0.05 * CARD.height), "5% of the card's height off the top");
  assert.ok(close(CARD.top + CARD.height - (at.top + at.height), 0.05 * CARD.height), "and 5% off the foot");
  const gap = besideRight(at, CARD, fit);
  assert.ok(gap > 16, `room to spare: ${gap}`);
});

test("a narrower window shrinks it, keeping the shape and the middle, with the least gap either side", () => {
  const fit = fitAt(1280);
  const at = place(CARD, fit, 34);
  assert.ok(at.height < TALL * CARD.height, `height ${at.height}`);
  assert.ok(close(besideRight(at, CARD, fit), 16), "both gaps are the clearance");
  assert.ok(close(at.width, edgeOf(fit) - RIGHT(CARD) - 32));
});

test("at every window width the gaps stay equal, and the box only grows as the window does", () => {
  let last = 0;
  for (let w = 1235; w <= 1700; w += 7) {
    const fit = fitAt(w);
    const at = place(CARD, fit, 34);
    besideRight(at, CARD, fit);
    assert.ok(at.width >= last - 1e-6, `smaller at ${w}`);
    last = at.width;
  }
  assert.ok(close(last, CARD.height * WIDE), "and stops at its full size");
});

test("a card made shorter or moved takes its box with it", () => {
  const fit = fitAt(1280);
  for (const card of [{ ...CARD, height: 520 }, { ...CARD, top: 180, height: 520 }, { ...CARD, left: 300 }]) {
    const at = place(card, fit, 34);
    besideRight(at, card, fit);
  }
  const shorter = place({ ...CARD, height: 480 }, fit, 34);
  assert.ok(close(shorter.height, TALL * 480), "a short enough card has a box nine tenths as tall as itself");
});

test("the room is read through the stage's scale and shift, in both panes", () => {
  const scaled = { scale: 0.8, tx: 20, left: 6.5, right: 1100, clear: 16 };
  const at = place(CARD, scaled, 34);
  // (1100 - 20) / .8 = 1350 on the stage, and the clearance is 16 screen pixels
  assert.ok(close(besideRight(at, CARD, scaled), 20), "16 on screen is 20 on a stage drawn at .8");
  const pane = { scale: 0.9, tx: -300, left: 0, right: 1000, clear: 16 };   // the right pane
  besideRight(place(CARD, pane, 34), CARD, pane);
});

test("with less than half the card's height beside it, it floats over the card's edge", () => {
  const fit = fitAt(1100);
  const at = place(CARD, fit, 34);
  assert.equal(at.floating, true);
  assert.ok(close(at.width / at.height, SHAPE));
  assert.ok(at.height <= TALL * CARD.height + 1e-6, "no taller than it would be beside the card");
  assert.ok(close(edgeOf(fit) - (at.left + at.width), 16), "the clearance in from the workspace's edge");
  assert.ok(at.left < RIGHT(CARD) && at.left > CARD.left, "over the card's right part");
  assert.ok(at.top > CARD.top + 34 && at.top - (CARD.top + 34) < 2 * CELL, "under the card's top bar");
  assert.ok(close(MIDDLE(at), MIDDLE(CARD)), "level with the card's middle");
  // a window just wider than the threshold keeps it beside the card
  const just = fitAt(1240);
  besideRight(place(CARD, just, 34), CARD, just);
});

test("in a window narrower than the box it never starts left of the workspace", () => {
  const fit = { scale: 1, tx: 0, left: 600, right: 700, clear: 16 };
  const at = place(CARD, fit, 34);
  assert.equal(at.floating, true);
  assert.ok(at.left >= 616 - 1e-6 && at.left + at.width <= 684 + 1e-6, `${at.left} to ${at.left + at.width}`);
  assert.ok(close(at.width / at.height, SHAPE));
  assert.ok(close(MIDDLE(at), MIDDLE(CARD)));
});

test("the page hands the box the workspace's own edges and the fit's clearance", () => {
  const html = read("index.html");
  const call = html.slice(html.indexOf("const at = MagicBox.place("), html.indexOf("MB.el.classList.toggle(\"floating\""));
  assert.match(call, /left: lim\.left - FRAME_CLEAR, right: lim\.right \+ FRAME_CLEAR, clear: FRAME_CLEAR/);
  assert.match(html, /const FRAME_CLEAR = 16;/);
});

test("the box is what it holds between the ticket list's two soft ends: no bar, edge, face or shadow", () => {
  const html = read("index.html");
  const rule = sel => {
    const at = html.indexOf("\n  " + sel + "{");
    assert.ok(at > 0, sel);
    return html.slice(at, html.indexOf("}", html.indexOf("100%)", html.indexOf("mask-image:", at))) + 1);
  };
  const masks = text => [...text.matchAll(/(?:-webkit-)?mask-image:(linear-gradient\([\s\S]*?100%\))/g)].map(m => m[1].replace(/\s+/g, " "));
  const list = masks(rule(".tikpane")), box = masks(rule("#magicbox .mbbody"));
  assert.equal(list.length, 2);
  assert.deepEqual(box, list, "the very ramp the ticket list draws, prefixed and not");
  // both bands at the list's own depth, held there, and one depth for both
  assert.match(rule("#magicbox .mbbody"), /--upband:var\(--listfade\); --downband:var\(--listfade\)/);
  assert.equal((html.match(/--listfade:\s*\d/g) || []).length, 1, "--listfade is set once, for both");
  const tokens = html.slice(html.indexOf("--cw:1440px"), html.indexOf("\n  }", html.indexOf("--cw:1440px")));
  assert.match(tokens, /--listfade:22px;/, "among the board's own tokens");
  // no bar: the box holds its body and nothing else, and nothing names a bar
  const section = html.slice(html.indexOf('<section id="magicbox">'), html.indexOf("</section>", html.indexOf('<section id="magicbox">')));
  assert.equal(section.replace(/\s+/g, ""), '<sectionid="magicbox"><divclass="mbbody"></div>');
  for (const gone of ["mbbar", "mbname", "mbopen", "mbx", "Open in Chrome", "close the box"])
    assert.ok(!html.includes(gone), gone);
  // beside the card the box and its body paint nothing of their own: no face,
  // no edge, no corners, no shadow
  const on = html.slice(html.indexOf("  body.focus #magicbox.on{"), html.indexOf("}", html.indexOf("  body.focus #magicbox.on{")));
  assert.match(on, /background:transparent; border:none; border-radius:0; box-shadow:none/);
  assert.ok(!/border|background|box-shadow|radius/.test(rule("#magicbox .mbbody")), "the body draws none of them");
  const sheet = html.slice(html.indexOf("  #magicbox{display:none}"), html.indexOf("  /* on the chat lane's tab"));
  assert.ok(!/solid|box-shadow:\s*0|border-radius:\s*7px/.test(sheet), "no edge, shadow or corner anywhere in the box");
  // floated over the card, only the card's white face, so the card's words do not show through
  assert.match(sheet, /#magicbox\.floating \.mbbody\{background:var\(--card\)\}/);
  assert.ok(sheet.length > 1000 && !/--accent/.test(sheet), "never the accent");
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
