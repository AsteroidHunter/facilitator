// Where a card's magic box stands, worked out without a browser: at full size
// nine tenths of the card's height and 1.14 times the width of an iPhone 13
// mini screen as tall as the card, smaller when the room right of the card is
// short, in the middle of that room so the gap to the card and the gap to the
// workspace's edge are equal, level with the card's middle, and over the card's
// edge rather than off the workspace when the window has no room; inside that
// largest box, a picture in its own shape and never past its own size, words
// at their own height. Its look, read from the page's source: what it holds and
// the ticket list's two soft ends, no bar, and the card's own frame and shadow
// only under the two Settings switches; with the shadow on, whichever of the
// card and the box is held stands up and the other settles. And the page's
// wiring: the box is never one of the regions the fit, the layout or edit mode
// work on, and a click or the focus says which of the two is held.
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

// what the box shows, inside the largest box there is room for
const SIZED = (want, fit = fitAt(1512)) => ({ most: place(CARD, fit, 34), at: place(CARD, fit, 34, want), fit });
function sizedRight({ most, at, fit }) {
  assert.ok(at.width <= most.width + 1e-6 && at.height <= most.height + 1e-6, "never larger than the largest box");
  assert.ok(close(MIDDLE(at), MIDDLE(CARD)), "level with the card's middle");
  if (!at.floating) {
    const gapCard = at.left - RIGHT(CARD), gapEdge = edgeOf(fit) - (at.left + at.width);
    assert.ok(close(gapCard, gapEdge), `gaps ${gapCard} and ${gapEdge}`);
  }
  return at;
}

test("a wide picture gets a wide, short box and a tall one a tall, narrow box, in its own shape", () => {
  const wide = sizedRight(SIZED({ width: 2000, height: 1000 }));
  assert.ok(close(wide.width / wide.height, 2) && close(wide.width, place(CARD, fitAt(1512), 34).width), "as wide as there is room");
  const tall = sizedRight(SIZED({ width: 600, height: 2400 }));
  assert.ok(close(tall.width / tall.height, 0.25) && close(tall.height, TALL * CARD.height), "as tall as there is room");
  const square = sizedRight(SIZED({ width: 1500, height: 1500 }));
  assert.ok(close(square.width, square.height));
});

test("a picture is never drawn past its own size, and a small one keeps its size", () => {
  const small = sizedRight(SIZED({ width: 200, height: 120 }));
  assert.deepEqual([small.width, small.height], [200, 120]);
  // the gaps are equal for the narrower width too
  assert.ok(small.left - RIGHT(CARD) > place(CARD, fitAt(1512), 34).left - RIGHT(CARD));
});

test("words take their own height up to the largest box, then scroll; a page or a site takes all of it", () => {
  const most = place(CARD, fitAt(1512), 34);
  const short = sizedRight(SIZED({ height: 180 }));
  assert.deepEqual([short.width, short.height], [most.width, 180], "the full width, their own height");
  const long = sizedRight(SIZED({ height: 5000 }));
  assert.deepEqual([long.width, long.height], [most.width, most.height], "no taller than the largest box");
  assert.deepEqual(place(CARD, fitAt(1512), 34, null), most, "a page or a site asks for nothing");
});

test("in a narrow window the picture is fitted inside the smaller box, and in no room it floats the same way", () => {
  sizedRight(SIZED({ width: 2000, height: 1000 }, fitAt(1280)));
  const afloat = sizedRight(SIZED({ width: 2000, height: 1000 }, fitAt(1100)));
  assert.equal(afloat.floating, true);
  assert.ok(close(edgeOf(fitAt(1100)) - (afloat.left + afloat.width), 16), "the clearance in from the workspace's edge");
});

test("the page hands the box the workspace's own edges, the fit's clearance and what it shows", () => {
  const html = read("index.html");
  const fn = html.slice(html.indexOf("function magicPlace(){"), html.indexOf("MB.el.classList.toggle(\"floating\""));
  assert.match(fn, /left: lim\.left - FRAME_CLEAR, right: lim\.right \+ FRAME_CLEAR, clear: FRAME_CLEAR/);
  assert.match(fn, /MagicBox\.place\(rect, fit, bar, magicWant\(most, S\)\)/);
  assert.match(html, /const FRAME_CLEAR = 16;/);
  // a picture asks for as many stage pixels as it has pixels on screen, its
  // size read once off a copy that is never laid out
  const want = html.slice(html.indexOf("function magicWant("), html.indexOf("function magicPlace(){"));
  assert.match(want, /const \[w, h\] = MB\.natural \|\| \[0, 0\];\s*return w && h \? \{ width: w \/ S \+ edges, height: h \/ S \+ edges \} : null;/);
  assert.match(want, /height: words\.offsetHeight \+ edges/);
  assert.match(html, /const own = new Image\(\);[\s\S]{0,200}MB\.natural = \[own\.naturalWidth, own\.naturalHeight\];/);
});

test("Settings has the two switches, kept with the board's settings and read on every placing", () => {
  const html = read("index.html");
  const appearance = html.slice(html.indexOf('data-section="appearance"'), html.indexOf('data-section="editor"'));
  assert.match(appearance, /<label class="setlabel" for="setmagicframe"><span>Magic box frame<\/span><\/label>\s*<input type="checkbox" role="switch" id="setmagicframe">/);
  assert.match(appearance, /<label class="setlabel" for="setmagicshadow"><span>Magic box shadow<\/span><\/label>\s*<input type="checkbox" role="switch" id="setmagicshadow">/);
  assert.ok(!/checked/.test(appearance), "both off at first");
  assert.match(html, /const MAGIC_FRAME_KEY = "magicframe", MAGIC_SHADOW_KEY = "magicshadow";/);
  const { isSetting } = require(path.join(ROOT, "board-settings.js"));
  for (const key of ["magicframe", "magicshadow"]) {
    assert.equal(isSetting(key), true, key);
    assert.match(read("server.py"), new RegExp("SETTINGS_KEY = re\\.compile\\([\\s\\S]*?\\|" + key + "[|\"]"), key);
  }
  const place = html.slice(html.indexOf("function magicPlace(){"), html.indexOf("MB.el.classList.toggle(\"floating\""));
  assert.match(place, /magicDress\(\);/);
});

test("the box is what it holds between the ticket list's two soft ends: no bar, and no edge, face or shadow unless switched on", () => {
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
  // as it comes, the box and its body paint nothing of their own: no face, no
  // edge, no corners, no shadow
  const on = html.slice(html.indexOf("  body.focus #magicbox.on{"), html.indexOf("}", html.indexOf("  body.focus #magicbox.on{")));
  assert.match(on, /background:transparent; border:none; border-radius:0; box-shadow:none/);
  assert.ok(!/border|background|box-shadow|radius/.test(rule("#magicbox .mbbody")), "the body draws none of them");
  const sheet = html.slice(html.indexOf("  #magicbox{display:none}"), html.indexOf("  /* on the chat lane's tab"));
  // the edge, corners and shadow live only under the two switches' classes, and
  // they are the card's own, as main wears them
  const card = html.slice(html.indexOf("  body.focus main{"), html.indexOf("}", html.indexOf("  body.focus main{")));
  const framed = sheet.match(/body\.focus #magicbox\.on\.framed\{([^}]*)\}/)[1];
  assert.match(card, /border:var\(--edge\) solid var\(--line\); background:#fff; border-radius:7px;/);
  assert.equal(framed, "border:var(--edge) solid var(--line); background:var(--card); border-radius:7px");
  // held, the card's own raised shadow; not held, the faint one the card
  // settles to under magic box 2
  const raised = sheet.match(/body\.focus #magicbox\.on\.framed\.shadowed\.held\{box-shadow:([^}]*)\}/)[1];
  assert.ok(card.includes("box-shadow:" + raised + ";"), "the card's own raised shadow");
  const faint = sheet.match(/body\.focus #magicbox\.on\.framed\.shadowed\{box-shadow:([^}]*)\}/)[1];
  assert.ok(html.includes("body.focus.minifocus main{box-shadow:" + faint + "}"), "the card's own settled shadow");
  const rest = sheet.replace(/body\.focus #magicbox\.on\.framed[^{]*\{[^}]*\}/g, "");
  assert.ok(!/solid|box-shadow:\s*0|border-radius:\s*7px/.test(rest), "no edge, shadow or corner anywhere else in the box");
  assert.ok(!/\.shadowed/.test(rest), "the shadow is never without the frame");
  // in the frame the ramp is dropped
  assert.match(sheet, /#magicbox\.framed \.mbbody\{-webkit-mask-image:none; mask-image:none\}/);
  // floated over the card, only the card's white face, so the card's words do not show through
  assert.match(sheet, /#magicbox\.floating \.mbbody\{background:var\(--card\)\}/);
  assert.ok(sheet.length > 1000 && !/--accent/.test(sheet), "never the accent");
});

test("with its shadow on, whichever of the card and the box is held stands up and the other settles, and nothing else changes", () => {
  const html = read("index.html");
  const settled = html.match(/body\.focus\.minifocus main\{box-shadow:([^}]*)\}/)[1];
  // the card settles only while an open, framed, shadowed box is held and
  // drawn, at the settled rule's own weight, ahead of the lowered card's rule,
  // so a lowered card stays level
  const rule = "  body.focus:not(.home, .editmode):has(:where(#magicbox.on.framed.shadowed.held)) main{box-shadow:" + settled + "}";
  assert.ok(html.includes(rule));
  assert.ok(html.indexOf(rule) < html.indexOf("  body.focus.lowered main{box-shadow:none}"));
  // both ease over the card's own timing, and the shadow is all they change
  const card = html.slice(html.indexOf("  body.focus main{"), html.indexOf("}", html.indexOf("  body.focus main{")));
  const on = html.slice(html.indexOf("  body.focus #magicbox.on{"), html.indexOf("}", html.indexOf("  body.focus #magicbox.on{")));
  assert.match(card, /transition:box-shadow \.2s;/);
  assert.match(on, /transition:box-shadow \.2s;/);
  const style = html.slice(0, html.indexOf("</style>"));
  const rules = [...style.matchAll(/\n  ([^\n{]*\.held[^\n{]*)\{([^}]*)\}/g)];
  assert.equal(rules.length, 2, "the box's rule and the card's");
  for (const [, , body] of rules) assert.match(body, /^box-shadow:[^;]*$/);
  // the box goes off the page settled; the agent's next revision keeps it held
  assert.match(html, /function magicOff\(\)\{\s*if \(!MB\.el\) return;\s*MB\.el\.classList\.remove\("on", "held"\);/);
  assert.match(html, /const held = id === MB\.id && MB\.el\.classList\.contains\("held"\);\s*magicOff\(\);\s*MB\.el\.classList\.toggle\("held", held\);/);
});

test("clicking or focusing into the box holds it; clicking elsewhere or focusing into the card hands it back", () => {
  const html = read("index.html");
  const from = html.indexOf("function magicHold(");
  const src = html.slice(from, html.indexOf("}));", html.indexOf('addEventListener("blur"', from)) + 4);
  const classes = new Set(["on", "framed", "shadowed"]), inBox = new Set(), on = {};
  const node = where => {
    const n = { closest: sel => (sel === "main" && where === "card" ? {} : null) };
    if (where === "box") inBox.add(n);
    return n;
  };
  const el = { contains: n => inBox.has(n),
    classList: { contains: c => classes.has(c), toggle: (c, yes) => (yes ? classes.add(c) : classes.delete(c)) } };
  const doc = { activeElement: null };
  vm.runInContext(src, vm.createContext({ MB: { el }, document: doc, setTimeout: fn => fn(),
    addEventListener: (type, fn, capture) => { on[type] = { fn, capture }; } }));
  const held = () => classes.has("held");
  const [box, frame, card, board] = [node("box"), node("box"), node("card"), node("board")];
  assert.equal(on.pointerdown.capture, true);
  assert.equal(on.focusin.capture, true);
  on.pointerdown.fn({ target: box }); assert.equal(held(), true, "a click in the box");
  on.pointerdown.fn({ target: card }); assert.equal(held(), false, "a click on the card");
  on.pointerdown.fn({ target: box }); on.pointerdown.fn({ target: board });
  assert.equal(held(), false, "a click anywhere else");
  on.focusin.fn({ target: box }); assert.equal(held(), true, "the focus moved into the box");
  on.focusin.fn({ target: board }); assert.equal(held(), true, "the focus elsewhere leaves it");
  on.focusin.fn({ target: card }); assert.equal(held(), false, "the focus moved into the card, to type");
  doc.activeElement = frame; on.blur.fn(); assert.equal(held(), true, "a click inside a page or site in the box");
  doc.activeElement = card; on.pointerdown.fn({ target: card }); on.blur.fn();
  assert.equal(held(), false, "the window losing the focus anywhere else leaves it");
  classes.delete("on");
  on.pointerdown.fn({ target: box }); assert.equal(held(), false, "a box that is not open is never held");
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
