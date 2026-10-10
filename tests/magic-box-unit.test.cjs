// Where a card's magic box stands, worked out without a browser: at full size
// nine tenths of the card's height and 1.14 times the width of an iPhone 13
// mini screen as tall as the card, smaller when the room right of the card is
// short, in the middle of that room so the gap to the card and the gap to the
// workspace's edge are equal, level with the card's middle, and over the card's
// edge rather than off the workspace when the window has no room; inside that
// largest box, a picture in its own shape and never past its own size, words
// at their own height, hung from that box's top, under a top bar that keeps
// its height. Its look, read from the page's source: the card's own edge, face,
// corners and shadow, always, a white top bar with the Mac's three lights, and
// a site that will not be framed as a square with its name in the middle;
// whichever of the card and the box is held stands up and the other settles,
// and a box beside a lowered card sits level with it. And the page's wiring: the box is never one of the regions the fit, the
// layout or edit mode work on, a click or the focus says which of the two is
// held, and a page in the box never takes the keys by itself.
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
  assert.ok(close(at.top, most.top), "its top on the largest box's top, not centred up and down");
  assert.equal(at.floating, most.floating);
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
  assert.deepEqual(long, most, "no taller than the largest box, and then exactly where it stood");
  // a short one hangs from the largest box's top, which is 5% of the card's
  // height under the card's own top, and keeps its left and right as before
  assert.ok(close(short.top - CARD.top, 0.05 * CARD.height));
  assert.ok(short.top + short.height < MIDDLE(CARD), "well above the card's middle");
  assert.equal(short.left, most.left);
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
  assert.match(fn, /MagicBox\.place\(rect, fit, bar, MB\.view\.want\(most, S\)\)/);
  assert.match(fn, /visibility: MB\.view\.waiting\(\) \? "hidden" : ""/);
  assert.match(html, /const FRAME_CLEAR = 16;/);
  // what it shows asks for, in the shared view (card-logic.js): a picture as
  // many of the page's pixels as it has pixels on screen, its size read once off
  // a copy that is never laid out, with the top bar as its head; words their
  // own height and the bar; a refused site a square
  const view = read("card-logic.js");
  const want = view.slice(view.indexOf("view.want = (room, scale = 1) => {"), view.indexOf("view.waiting = () => {"));
  assert.match(want, /head = view\.bar\.offsetHeight/);
  assert.match(want, /const \[w, h\] = view\.natural \|\| \[0, 0\];\s*return w && h \? \{ width: w \/ scale \+ edges, height: h \/ scale \+ edges, head \} : null;/);
  assert.match(want, /if \(view\.body\.querySelector\("\.mbaway"\)\) return \{ height: room\.width \};/);
  assert.match(want, /height: words\.offsetHeight \+ edges \+ head/);
  assert.match(view, /const own = new Image\(\);[\s\S]{0,200}view\.natural = \[own\.naturalWidth, own\.naturalHeight\];/);
  assert.match(html, /MB\.view = magicView\(MB\.el, \{ placed: \(\) => magicPlace\(\), openSite: magicOpenSite \}\);/);
});

test("in any room, what the box shows is fitted the same way: the phone's drawer is such a room", () => {
  const fitted = api().fit, fit = (room, want) => ({ ...fitted(room, want) });   // a plain object, outside the script's realm
  const room = { width: 360, height: 420 };
  assert.deepEqual(fit(room, null), room, "a page or a site takes the whole room");
  assert.deepEqual(fit(room, { height: 150 }), { width: 360, height: 150 }, "words their own height");
  assert.deepEqual(fit(room, { height: 900 }), room, "and no taller than the room");
  assert.deepEqual(fit(room, { width: 200, height: 120, head: 34 }), { width: 200, height: 154 }, "a small picture its own size");
  const wide = fit(room, { width: 3600, height: 1800, head: 34 });
  assert.ok(close(wide.width, 360) && close(wide.height, 180 + 34), "a wide one as wide as the room, the bar kept");
  assert.deepEqual(fit(room, { height: room.width }), { width: 360, height: 360 }, "a refused site a square");
});

test("a picture's top bar keeps its height while the picture under it is fitted to what is left", () => {
  const fit = fitAt(1512), most = place(CARD, fit, 34), bar = 34;
  const tall = place(CARD, fit, 34, { width: 600, height: 2400, head: bar });
  assert.ok(close(tall.height, most.height), "as tall as the largest box, bar and all");
  assert.ok(close((tall.height - bar) / tall.width, 4), "the picture keeps its own shape under the bar");
  const small = place(CARD, fit, 34, { width: 200, height: 120, head: bar });
  assert.deepEqual([small.width, small.height], [200, 120 + bar], "a small picture keeps its size, the bar above it");
  assert.ok(close(small.top, most.top), "and hangs from the largest box's top");
});

test("the box's edge and shadow are no setting: no switch, and no key for one", () => {
  const html = read("index.html");
  for (const gone of ["setmagicframe", "setmagicshadow", "Magic box frame", "Magic box shadow", "magicframe", "magicshadow",
    "magicDress", ".framed", ".shadowed"])
    assert.ok(!html.includes(gone), gone);
  const { isSetting } = require(path.join(ROOT, "board-settings.js"));
  for (const key of ["magicframe", "magicshadow"]) {
    assert.equal(isSetting(key), false, key);
    assert.ok(!read("server.py").includes(key), key);
  }
});

// the box's look, kept once in the shared sheet for both pages
const boxSheet = () => { const css = read("card-tokens.css"); return css.slice(css.indexOf("/* ---- a card's magic box")); };

// the box's own block of the shared sheet, and a sheet's rules without comments
const boxBlock = () => { const css = read("card-tokens.css"), at = css.indexOf("/* ---- a card's magic box");
  return css.slice(at, css.indexOf("/* a card's picture opened full screen", at)); };
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, "");

test("the box has no frame, face or shadow: a short bar parted from what it holds by the ticket list's own line, and one cross, on both pages", () => {
  const html = read("index.html"), phone = read("m.html"), sheet = boxSheet(), block = code(boxBlock()), logic = read("card-logic.js");
  const box = code(sheet.match(/\n\.magicbox\{([^}]*)\}/)[1]);
  // no frame: no edge, no face, no corners and no shadow, in the box's own rule
  // or anywhere in its block but the site square's own tile, which is content
  assert.ok(!/background|border|radius|box-shadow/.test(box), "the box draws a frame of its own");
  assert.ok(!/box-shadow/.test(block), "something in the box casts a shadow");
  assert.ok(!/\.magicbox\.held|body\.lowered \.magicbox/.test(block), "a shadow state is left");
  // the board only says where it stands and its words' inset; floated over
  // the card for want of room, it stands on the board's own paper, so the
  // card's words do not show through it, still with no edge or shadow
  const on = html.slice(html.indexOf("  body.focus #magicbox.on{"), html.indexOf("}", html.indexOf("  body.focus #magicbox.on{")));
  assert.match(on, /display:flex; position:fixed; z-index:1; --mb-inset:calc\(var\(--pad-x\)\*2\/3\)/);
  assert.match(html, /  body\.focus #magicbox\.on\.floating\{background:var\(--paper\)\}/);
  assert.ok(!/#magicbox \.mb/.test(html), "no look of its own on the board");
  // the bar: nothing of its own, the cross's seat with the same gap over and
  // under it as at the box's side, so the cross's middle stands as far from
  // the box's edge as from its side, and the seat clear of the line by that gap
  const bar = sheet.match(/\.magicbox \.mbbar\{([^}]*)\}/)[1];
  assert.match(bar, /position:relative/);
  assert.match(bar, /justify-content:flex-end/);
  assert.match(bar, /align-items:center/);
  assert.match(bar, /height:var\(--mb-bar\)/);
  assert.match(bar, /padding:0 var\(--mb-gap\)/);
  assert.ok(!/background|box-shadow|border/.test(bar), "the bar paints something of its own");
  assert.match(box, /--mb-bar:calc\(var\(--mb-x\) \+ 2 \* var\(--mb-gap\)\);/);
  const own = phone.match(/  #mbface\{display:none;([^}]*)\}/)[1];
  assert.ok(!/--mb-bar/.test(own), "the phone sets its own bar, apart from the seat and the gap");
  assert.match(read("card-tokens.css"), /--cardbar-h:34px;/);
  for (const [where, seat, gap] of [["board", box.match(/--mb-x:(\d+)px;/), box.match(/--mb-gap:(\d+)px;/)],
                                    ["phone", own.match(/--mb-x:calc\((\d+) \* var\(--u\)\);/), own.match(/--mb-gap:calc\((\d+) \* var\(--u\)\);/)]]) {
    const x = +seat[1], g = +gap[1], height = x + 2 * g;
    assert.equal(g + x / 2, (height - x) / 2 + x / 2, where + ": the cross's middle is not as far from the edge as from the side");
    assert.ok(g >= 5, where + ": the seat stands closer than the card bar's 5px to the box's edges and the line");
    assert.ok(height < 34, where + ": the box's bar is no shorter than the card's");
    assert.ok(x >= 12 + 2 * 4, where + ": the seat leaves under 4px about the 12px mark");
  }
  // the line: the ticket list's under its section names, word for word, in
  // each page (#tikhead::after): the card's hairline as a top edge of no
  // height, across the whole width, taking no touch
  const line = sheet.match(/\.magicbox \.mbbar::after\{([^}]*)\}/)[1].replace(/\s+/g, " ");
  assert.match(line, /content:""; position:absolute; pointer-events:none;/);
  assert.match(line, /left:0; right:0; top:var\(--mb-line-top\); bottom:var\(--mb-line-foot\); height:0;/);
  assert.match(line, /border-top:var\(--edge\) solid var\(--line\)$/);
  for (const page of [html, phone]) {
    const list = page.match(/  #tikhead::after\{([^}]*)\}/)[1].replace(/\s+/g, " ");
    assert.match(list, /content:""; position:absolute; pointer-events:none;/);
    assert.match(list, /left:0; right:0; height:0;/);
    assert.match(list, /border-top:var\(--edge\) solid var\(--line\);/);
  }
  // it runs along the bar's foot where the bar is at the head, and along the
  // bar's top where it stands at the foot (the phone, a portrait window)
  assert.match(box, /--mb-flow:column; --mb-air-head:0px; --mb-air-foot:var\(--mb-air\); --mb-line-top:auto; --mb-line-foot:0px/);
  assert.match(sheet, /\.magicbox\.barfoot\{--mb-flow:column-reverse; --mb-air-head:var\(--mb-air\); --mb-air-foot:0px; --mb-line-top:0px; --mb-line-foot:auto\}/);
  assert.match(sheet, /@media \(orientation:portrait\)\{\s*\.magicbox\{--mb-flow:column-reverse; --mb-air-head:var\(--mb-air\); --mb-air-foot:0px; --mb-line-top:0px; --mb-line-foot:auto\}\s*\}/);
  assert.match(box, /flex-direction:var\(--mb-flow\)/);
  // words run out to the box's sides, the line's ends, with no frame to keep off
  assert.match(sheet, /\.magicbox \.mbtext\{padding:calc\(var\(--mb-lead\) - var\(--mb-air-head\)\) 0 var\(--mb-inset, 16px\);/);
  // one cross, a button that closes the box, in the bar, on the board and on
  // the phone alike
  for (const [page, open] of [[html, '<section id="magicbox" class="magicbox">'], [phone, '<section id="mbface" class="magicbox barfoot"']]) {
    const section = page.slice(page.indexOf(open), page.indexOf("</section>", page.indexOf(open)));
    assert.ok(section.length > 0, open);
    const bar = section.slice(section.indexOf('<div class="mbbar">'), section.indexOf("</div>", section.indexOf('<div class="mbbar">')));
    assert.equal(bar.trim().split("\n").slice(1).map(l => l.trim()).join(""),
      '<button type="button" class="mbclose" aria-label="Close the magic box"></button>');
    assert.ok(!/mblight/.test(page), "a light is left on the page");
  }
  // its mark is drawn once, by the view both pages share, in the card bar's
  // own family: the 24 grid, the 2.4 stroke and round ends, at the card bar's
  // mark size, in a seat with no fill that a press shades with the one press
  // shade over whatever paper the board wears
  const cross = logic.match(/const MAGIC_CROSS = ('[^;]*);/)[1];
  assert.match(cross, /viewBox="0 0 24 24"/);
  assert.match(cross, /stroke-width="2\.4"/);
  assert.match(cross, /stroke-linecap="round"/);
  assert.match(logic, /const cross = el\.querySelector\("\.mbclose"\);\s*if \(cross\) cross\.innerHTML = MAGIC_CROSS;/);
  assert.match(sheet, /\.magicbox \.mbclose svg\{width:calc\(var\(--bar-mark\) \* var\(--chip-scale\)\); height:calc\(var\(--bar-mark\) \* var\(--chip-scale\)\)\}/);
  const seat = sheet.match(/\.magicbox \.mbclose\{([^}]*)\}/)[1];
  assert.match(seat, /width:var\(--mb-x\); height:var\(--mb-x\); padding:0; border:none; border-radius:var\(--sq\);/);
  assert.match(seat, /background:transparent;/);
  assert.match(sheet, /\.magicbox \.mbclose:hover, \.magicbox \.mbclose:active\{background:color-mix\(in srgb, #000 var\(--press\), transparent\)\}/);
  assert.ok(sheet.length > 1000 && !/--accent/.test(sheet), "never the accent");
});

test("what the box holds keeps white at its far edge, and words that scroll dissolve at both ends as the ticket list does", () => {
  const html = read("index.html"), sheet = boxSheet(), logic = read("card-logic.js");
  // white between what it holds and the far edge, a picture excepted, which
  // fills its box in its own shape
  assert.match(sheet, /\.magicbox \.mbbody\{[^}]*margin:var\(--mb-air-head\) 0 var\(--mb-air-foot\)\}/);
  assert.match(sheet, /\.magicbox \.mbbody\[data-kind="image"\]\{margin:0\}/);
  // the fuzz: the ticket list's own ramp, word for word, on words alone
  const ramp = s => s.replace(/\s+/g, " ").trim();
  const list = ramp(html.match(/\.tikpane\{[^}]*?mask-image:(linear-gradient\([^;]*\));?\}/)[1]);
  const fuzz = sheet.match(/\.magicbox \.mbbody:is\(\[data-kind="text"\], \[data-kind="markdown"\]\)\{([^}]*)\}/)[1];
  assert.equal(ramp(fuzz.match(/-webkit-mask-image:([^;]*);/)[1]), list);
  assert.equal(ramp(fuzz.match(/(?:^|[;\s])mask-image:([^;]*)$/)[1]), list);
  // its depth is the ticket list's, on the board and on the phone; the phone
  // registers it as a length, as it does the list's, so the view reads pixels
  // from its scaled calc() too
  assert.match(sheet, /--mb-fade:22px;/);
  assert.match(read("m.html"), /@property --mb-fade\{syntax:"<length>"; inherits:false; initial-value:0px\}/);
  assert.match(read("m.html"), /--mb-fade:calc\(22 \* var\(--u\)\)/);
  assert.match(html, /#tiklist\{--listfade:22px;/);
  // the view writes the two bands as tickBands does, and reads them again as
  // the words scroll, are drawn, or change size
  const view = logic.slice(logic.indexOf("function magicView("), logic.indexOf("view.clear = () => {"));
  assert.match(view, /const up = Math\.min\(Math\.round\(b\.scrollTop\), view\.fade\);/);
  assert.match(view, /const down = Math\.min\(Math\.max\(0, Math\.round\(b\.scrollHeight - b\.clientHeight - b\.scrollTop\)\), view\.fade\);/);
  assert.match(view, /view\.body\.addEventListener\("scroll", bands, \{ passive: true \}\);/);
  assert.match(logic, /view\.body\.appendChild\(prose\);\s*if \(sized\) sized\.observe\(prose\);\s*bands\(\);/);
  // and the box asks for that white with what it shows, so words that fit
  // still fit, and nothing of a picture is lost to it
  assert.match(logic, /head = view\.bar\.offsetHeight \+ \(parseFloat\(air\.marginTop\) \|\| 0\) \+ \(parseFloat\(air\.marginBottom\) \|\| 0\);/);
});

test("the words start as far under the bar as the card's title does under its own, a heading first or not", () => {
  const sheet = boxSheet(), phone = read("m.html");
  // the first line keeps no top margin of its own: a heading's would add a
  // line's worth of white over it
  assert.match(sheet, /\.magicbox \.mbtext > :first-child\{margin-top:0\}/);
  // the words' top padding is the lead less what white the box already keeps
  // over them, so the first line stands --mb-lead under the bar's foot, or
  // under the box's top where the bar stands at the foot
  assert.match(sheet, /\.magicbox \.mbtext\{padding:calc\(var\(--mb-lead\) - var\(--mb-air-head\)\) 0 /);
  // measured on the simulators: the card's title's capitals stand 19.2px under
  // the card's bar on the board and 17.4px on the phone; a first line's
  // capitals stand 6.1px (a heading) to 6.5px (plain words) under its top
  const box = sheet.match(/\n\.magicbox\{([^}]*)\}/)[1];
  const lead = +box.match(/--mb-lead:(\d+(?:\.\d+)?)px;/)[1];
  assert.ok(Math.abs(lead + 6.1 - 19.2) < .6 && Math.abs(lead + 6.5 - 19.2) < .6, "the board's lead does not put the first line where the card's title stands");
  const own = phone.match(/  #mbface\{display:none;([^}]*)\}/)[1];
  const phoneLead = +own.match(/--mb-lead:calc\((\d+(?:\.\d+)?) \* var\(--u\)\)/)[1] * .984;
  assert.ok(Math.abs(phoneLead + 6.1 - 17.4) < .6 && Math.abs(phoneLead + 6.5 - 17.4) < .6, "the phone's lead does not put the first line where the card's title stands");
});

// the view's two bands, worked on a stand-in body: none at rest, the top one as
// the words scroll, capped at the fuzz's depth, and none at the end of the scroll
test("the box's bands follow the words' scroll, capped at the fuzz's depth", () => {
  const logic = read("card-logic.js");
  const src = logic.slice(logic.indexOf("const MAGIC_CROSS = "), logic.indexOf("// a site's name as the site gives it"))
    + logic.slice(logic.indexOf("function magicView("), logic.indexOf("\n}\n", logic.indexOf("function magicView(")) + 3);
  const props = {}, listeners = {};
  const body = { dataset: {}, scrollTop: 0, scrollHeight: 600, clientHeight: 200, textContent: "",
    style: { setProperty: (k, v) => { props[k] = v; } },
    addEventListener: (type, fn) => { listeners[type] = fn; }, appendChild() {}, querySelector: () => null };
  const cross = { innerHTML: "" };
  const el = { querySelector: s => s === ".mbbody" ? body : s === ".mbclose" ? cross : {} };
  const ctx = vm.createContext({ getComputedStyle: () => ({ getPropertyValue: () => "22px" }), addEventListener() {}, h() {}, MagicBox: {} });
  vm.runInContext(src, ctx);
  ctx.magicView(el);
  assert.match(cross.innerHTML, /^<svg viewBox="0 0 24 24"/, "the cross is drawn into the bar's button");
  listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "0px", "--downband": "22px" }, "at the top: no band over the words' top, the full band at the foot");
  body.scrollTop = 9; listeners.scroll();
  assert.equal(props["--upband"], "9px", "the top band follows the scroll");
  body.scrollTop = 120; listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "22px", "--downband": "22px" }, "capped at the fuzz's depth");
  body.scrollTop = 400; listeners.scroll();
  assert.equal(props["--downband"], "0px", "at the end of the scroll no band at the foot");
});

test("the cross puts the box away as the agent's close does, and the board keeps what it held", () => {
  const html = read("index.html");
  assert.match(html, /MB\.el\.querySelector\("\.mbclose"\)\.addEventListener\("click", \(\) => magicClose\(\)\)/);
  const fn = html.slice(html.indexOf("function magicClose(){"), html.indexOf("function magicPlace(){"));
  assert.match(fn, /if \(b && b\.magic\) b\.magic\.open = false;\s*magicOff\(\);/);
  assert.match(fn, /fetch\("\/magic\/close\?box=" \+ encodeURIComponent\(id\), \{ method: "POST" \}\)/);
});

test("a site that will not be framed comes square, with its name and a new-page mark in a box in the middle", () => {
  const view = read("card-logic.js");
  const nameFn = view.slice(view.indexOf("function magicSiteName("), view.indexOf("function magicView("));
  const ctx = vm.createContext({ URL });
  vm.runInContext(nameFn, ctx);
  assert.equal(ctx.magicSiteName({ url: "https://www.google.com/", preview: { site: "www.google.com" } }), "google.com");
  assert.equal(ctx.magicSiteName({ url: "https://github.com/x", preview: { site: "GitHub" } }), "GitHub");
  assert.equal(ctx.magicSiteName({ url: "https://www.example.org/" }), "example.org");
  const draw = view.slice(view.indexOf("view.draw = box => {"), view.indexOf("const page = (html, tries) => {"));
  assert.match(draw, /const away = h\("div", "mbaway"\), open = h\("button", "mbopen"\);/);
  assert.match(draw, /open\.setAttribute\("aria-label", "Open " \+ name \+ " in a new page"\);/);
  assert.match(draw, /open\.insertAdjacentHTML\("beforeend", MAGIC_NEW_PAGE\);/);
  assert.match(draw, /open\.addEventListener\("click", \(\) => \{ if \(view\.url && hooks\.openSite\) hooks\.openSite\(view\.url\); \}\);/);
  // the board opens it in the owner's browser on the Mac, the phone in a new page
  assert.match(read("index.html"), /function magicOpenSite\(url\)\{/);
  assert.match(read("m.html"), /openSite: url => window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  const sheet = boxSheet();
  assert.match(sheet, /--mbtile:color-mix\(in srgb, var\(--ink\) 4%, var\(--card\)\)/, "its own fill, whatever colour the board is");
  assert.match(sheet, /\.magicbox \.mbopen:hover\{background:color-mix\(in srgb, #000 calc\(var\(--press\) \/ 2\), var\(--mbtile\)\)\}/);
  assert.match(sheet, /\.magicbox \.mbopen:active\{background:color-mix\(in srgb, #000 var\(--press\), var\(--mbtile\)\)\}/);
});

test("clicking into the box moves no shadow, the card's or its own", () => {
  const html = read("index.html"), phone = read("m.html");
  // no held state anywhere: no rule for one in either page or the box's block,
  // and nothing in the board's box script sets one
  const style = code(html.slice(0, html.indexOf("</style>")));
  assert.ok(!/\.held\b/.test(style) && !/\.held\b/.test(code(boxBlock())), "a held rule is left");
  const script = html.slice(html.indexOf("function magicCard("), html.indexOf('addEventListener("blur", () => setTimeout(magicFocusCame));'));
  assert.ok(!/magicHold|"held"/.test(script), "the box is still held");
  assert.match(script, /MB\.el\.classList\.remove\("on", "over"\);/);
  assert.match(phone, /<section id="mbface" class="magicbox barfoot"/);
  // the card keeps its own shadow rules, none of them about its box: raised,
  // settled under magic box 2's composer, level once lowered
  assert.ok(html.includes("  body.focus.minifocus main{box-shadow:0 2px 18px rgba(60,45,20,.06)}"));
  assert.ok(html.includes("  body.focus.lowered main{box-shadow:none}"));
  assert.ok(!/#magicbox[^{]*main\s*\{/.test(style), "the card's shadow still answers to its box");
  // and neither page gives its box a shadow, an edge or a face: no rule there
  // whose subject, the last part of the selector, is the box sets one, but
  // the board's floating box, which stands on the board's own paper
  const subjects = selectors => selectors.split(",").map(s => s.trim().split(/\s+/).pop());
  for (const [name, page] of [["index.html", html], ["m.html", phone]]) {
    const own = [...code(page.slice(0, page.indexOf("</style>"))).matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter(m => /box-shadow|border|background/.test(m[2]) && subjects(m[1]).some(s => /^(#magicbox|#mbface|\.magicbox)\b/.test(s)));
    assert.deepEqual(own.map(m => m[1].trim()), name === "index.html" ? ["body.focus #magicbox.on.floating"] : [],
      name + " dresses its box itself");
  }
});

test("a page in the box never takes the keys by itself, and the board knows where the owner was", () => {
  const html = read("index.html");
  const last = 'addEventListener("blur", () => setTimeout(magicFocusCame));';
  const src = html.slice(html.indexOf('addEventListener("focusin", e => { if (MB.el && !MB.el.contains(e.target)) MB.back = e.target; }, true);'),
    html.indexOf(last) + last.length);
  const classes = new Set(["on"]), inBox = new Set(), on = {};
  const doc = { activeElement: null };
  const node = where => {
    const n = { where, isConnected: true, focused: 0,
      focus() { this.focused++; doc.activeElement = this; }, blur() { doc.activeElement = null; } };
    if (where === "box") inBox.add(n);
    return n;
  };
  const el = { contains: n => inBox.has(n),
    classList: { contains: c => classes.has(c), toggle: (c, yes) => (yes ? classes.add(c) : classes.delete(c)) } };
  let now = 100000;
  const MB = { el };
  vm.runInContext(src, vm.createContext({ MB, document: doc, setTimeout: fn => fn(), Date: { now: () => now },
    addEventListener: (type, fn, capture) => { (on[type] = on[type] || []).push({ fn, capture }); } }));
  const fire = (type, e) => { for (const l of on[type] || []) l.fn(e); };
  const [cover, frame, card, board] = [node("box"), node("box"), node("card"), node("board")];
  for (const type of ["focusin", "pointerdown", "pointerover", "pointermove", "keydown"])
    assert.ok(on[type].length && on[type].every(l => l.capture === true), type);
  // the focus moving outside the box is where the owner was; into it, not
  fire("focusin", { target: card });
  fire("focusin", { target: cover });
  assert.equal(MB.back, card, "the board knows where the owner was");
  // the owner types in the card, the pointer elsewhere: a page in the box takes
  // the keys, and they go straight back
  fire("pointermove", { target: board });
  assert.equal(MB.over, false);
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, card, "the keys are back in the card");
  assert.equal(card.focused, 1);
  // the owner's own click: the pointer lands on the frame's cover first
  fire("pointerover", { target: cover });
  assert.equal(MB.over, true);
  assert.ok(classes.has("over"), "the cover comes off");
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, frame, "the keys stay in the frame");
  // a Tab into the frame is the owner's too, for a second
  fire("pointermove", { target: board });
  fire("keydown", { key: "Tab" });
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, frame, "a Tab");
  now += 2000;
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, card, "long after a Tab, the page's own doing");
  // nowhere to go back to: the frame lets go
  MB.back = null;
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, null);
  // a box that is not open is never under the pointer
  classes.delete("on");
  fire("pointerover", { target: cover }); assert.equal(MB.over, false);
  // every frame comes with its cover, which is gone while the pointer is over the box
  assert.equal((read("card-logic.js").match(/view\.body\.append\(frame, h\("div", "mbcover"\)\);/g) || []).length, 2);
  assert.match(boxSheet(), /\.magicbox \.mbcover\{position:absolute; inset:0\}/);
  assert.match(boxSheet(), /\.magicbox\.over \.mbcover\{display:none\}/);
});

test("an agent's page cannot focus anything until the owner has just clicked or typed in it", () => {
  const { KEYS_GUARD, pageDoc } = api();
  const doc = pageDoc("<p>x</p>", "w");
  assert.ok(doc.indexOf(KEYS_GUARD) > 0 && doc.indexOf(KEYS_GUARD) < doc.indexOf("postMessage") &&
    doc.indexOf(KEYS_GUARD) < doc.indexOf("<p>x</p>"), "it runs before anything else in the page");
  const calls = [];
  const proto = () => ({ focus() { calls.push(this.name); } });
  const ctx = { navigator: { userActivation: { isActive: false } }, HTMLElement: { prototype: proto() },
    SVGElement: { prototype: proto() }, focus() { calls.push("window"); } };
  ctx.window = ctx;
  vm.runInContext(KEYS_GUARD, vm.createContext(ctx));
  const field = Object.create(ctx.HTMLElement.prototype);
  field.name = "field";
  const drawing = Object.create(ctx.SVGElement.prototype);
  drawing.name = "drawing";
  field.focus(); drawing.focus(); ctx.window.focus();
  assert.deepEqual(calls, [], "nothing taken while the owner is elsewhere");
  ctx.navigator.userActivation.isActive = true;
  field.focus(); drawing.focus(); ctx.window.focus();
  assert.deepEqual(calls, ["field", "drawing", "window"], "taken right after the owner's own click or key");
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

test("the shared view builds its frames from those lists, and a site's frame carries no logins", () => {
  const view = read("card-logic.js");
  assert.match(view, /frame\.setAttribute\("sandbox", MagicBox\.PAGE_SANDBOX\)/);
  assert.match(view, /frame\.srcdoc = MagicBox\.pageDoc\(html, run\.word\)/);
  assert.match(view, /frame\.setAttribute\("credentialless", ""\)/);
  assert.match(view, /frame\.setAttribute\("sandbox", MagicBox\.SITE_SANDBOX\)/);
  assert.equal((view.match(/frame\.setAttribute\("referrerpolicy", "no-referrer"\)/g) || []).length, 2);
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

// the phone's box script, the separate one at the foot of m.html, run against
// stand-ins for the page: card "a" has an open box and card "b" none. the drawer
// is a model of the page's: its face and side are the box script's own, and
// out, shut and the run it goes back on are the stand-ins'
function phoneBoxScript(page) {
  const start = page.indexOf("<script>\n// ---- the card's magic box, in the card list's drawer");
  const src = page.slice(start + "<script>".length, page.indexOf("</script>", start));
  const classes = new Set(), listeners = {}, calls = [], drawer = { settings: false, runs: [] };
  // keyframes played on a part: what was asked, and a finish the test gives
  const anims = [];
  const animate = part => (keys, opts) => {
    let done, fail;
    const a = { part, keys, opts, startTime: null, cancelled: false,
      finished: new Promise((resolve, reject) => { done = resolve; fail = reject; }),
      cancel() { a.cancelled = true; fail(new Error("cancelled")); }, finish() { done(); } };
    a.finished.catch(() => {});
    anims.push(a);
    return a;
  };
  const tickets = { dataset: { side: "left" }, clientWidth: 346, clientHeight: 433,
    classList: { contains: c => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      remove: c => classes.delete(c) },
    getAnimations: () => drawer.runs, animate: animate("drawer"), querySelector: () => null };
  const settings = { dataset: { side: "right" } };
  const box = { offsetHeight: 89, style: {}, querySelector: () => ({ addEventListener() {} }) };
  const face = () => (classes.has("boxface") ? "box" : "list") + " from the " + tickets.dataset.side;
  const paneClasses = new Set(), paneListeners = {};
  const cardPane = { getAnimations: () => [], animate: animate("card"), offsetWidth: 0,
    classList: { add: c => paneClasses.add(c), remove: c => paneClasses.delete(c), contains: c => paneClasses.has(c) },
    addEventListener: (type, fn) => { paneListeners[type] = fn; } };
  const ctx = {
    document: { getElementById: () => box, body: { classList: { add() {} } } },
    tickets, settings, innerWidth: 402, homeOpen: false, shownId: "a", activeOwner: "p",
    tikwin: { getAnimations: () => [], animate: animate("window") }, cardPane, tikArrows: [],
    // the page's run machinery, as far as the swap uses it: a straight spring of
    // 100ms, the drawer's 300px travel, the card's drop (120px under the list,
    // 90px under the box) and a stop that cancels what is playing
    LIST_KEYED: true, LIST_CALM: { matches: false }, LIST_FADE_TOP: .999, LIST_SETUP_MS: 200,
    listSpring: (from, to) => ({ ms: 100, at: t => from + (to - from) * Math.min(1, t / 100), velocity: () => 0 }),
    menuTravel: () => 300, menuSign: p => p.dataset.side === "right" ? -1 : 1,
    listDrop: 120, listPlay: [], listRun: null, ticketDrawerRun: 0, performance: { now: () => 0 },
    stopList: () => { for (const a of ctx.listPlay) a.cancel(); ctx.listPlay = []; },
    settleTicketDrawer: () => calls.push("settled"), renderTickets() {},
    lastState: { boxes: [{ id: "a", owner: "p", done: false, magic: { open: true, rev: 1 } }, { id: "b", owner: "p", done: false }] },
    magicView: () => ({ body: {}, want: () => ({ height: 89 }), waiting: () => false, draw() {}, clear() {} }),
    MagicBox: { fit: (room, want) => ({ width: room.width, height: Math.min(room.height, want.height) }) },
    menuOut: () => classes.has("open") ? tickets : drawer.settings ? settings : null,
    drawerOpen: () => classes.has("open"),
    // showing one drawer puts the other away, as the page's showMenu does
    showMenu: p => {
      if (p === settings) { classes.delete("open"); drawer.settings = true; calls.push("settings"); return; }
      drawer.settings = false; classes.add("open"); calls.push("show " + face());
    },
    // shutting the drawer starts its run back, which lands when the test says,
    // and its hiding, which outlasts the run and is not to be waited for
    closeDrawer: () => {
      classes.delete("open"); calls.push("close " + face());
      let land;
      drawer.runs = [{ id: "list-run", finished: new Promise(r => { land = r; }) },
        { transitionProperty: "visibility", finished: new Promise(() => {}) }];
      drawer.land = async () => { land(); drawer.runs = []; await new Promise(r => setImmediate(r)); };
    },
    listMoving: () => drawer.runs.length > 0,
    fitList: now => { if (now) ctx.listDrop = classes.has("boxface") ? 90 : 120; }, poll() {},
    fetch: url => { calls.push(url); return new Promise(() => {}); },
    apply: () => calls.push("apply"), select: () => calls.push("select"), deselect: () => calls.push("deselect"),
    openDrawer: () => calls.push("list"), listSlack: () => 7,
    phoneShortcutActions: {}, menuShortcutActions: {},
    addEventListener: (type, fn, opts) => { (listeners[type] = listeners[type] || []).push({ fn, opts }); },
  };
  vm.runInContext(src, vm.createContext(ctx));
  return { ctx, classes, tickets, listeners, calls, drawer, anims, paneClasses, paneListeners };
}

test("on the phone the box comes down in the card list's own drawer, from the right, pulled the other way from the list", () => {
  const page = read("m.html");
  // the drawer wears the box in place of the list, and comes in from the right for it
  assert.match(page, /#tickets\.boxface > #tikhead, #tickets\.boxface > #tiklist\{display:none\}/);
  assert.match(page, /#tickets\[data-side="right"\]\{\s*transform:translate3d\(calc\(\(1 - var\(--list-v\)\) \* \(var\(--pg-r\)/);
  assert.match(page, /else if \(x >= innerWidth - EDGE && tickets\.dataset\.side === "right"\)\{ panel = tickets; opening = true; \}/);
  // no pull opens the settings: their circle alone does
  const gesture = page.slice(page.indexOf("const start = (x, y, t, target) => {"), page.indexOf("const move = (x, y, t) => {"))
    .replace(/\/\/.*$/gm, "");
  assert.ok(gesture.includes("panel = tickets") && !gesture.includes("settings"), "a pull can still bring the settings");
  assert.match(page, /const direction = flick\(\) \* menuSign\(panel\);/, "a flick opens the way the drawer comes in");
  assert.match(page, /travel = menuTravel\(tickets\) \* menuSign\(tickets\);/, "its slide comes from its own side");
  assert.ok(!page.includes("MAGIC_PULL"), "the pull's side is settled, with no switch left to change");
  assert.match(read("server.py"), /def _phone_box[\s\S]*?\*\*\(\{"magic": b\["magic"\]\} if b\.get\("magic"\) else \{\}\),/, "the phone's reading carries the box");
  // the box's own script, run against stand-ins for the page
  const { ctx, classes, tickets, listeners, calls } = phoneBoxScript(page);
  const touch = x => { for (const l of listeners.touchstart) l.fn({ touches: [{ clientX: x }] }); };
  assert.ok(listeners.touchstart.every(l => l.opts.capture === true), "the face is chosen before the drawer's own gesture");
  touch(400);
  assert.ok(classes.has("boxface") && tickets.dataset.side === "right", "a right-edge pull on a card with a box");
  assert.equal(ctx.listSlack(), 433 - 89, "the card goes down only as far as the box needs");
  touch(2);
  assert.ok(!classes.has("boxface") && tickets.dataset.side === "left", "the left edge brings the list");
  assert.equal(ctx.listSlack(), 7, "and the list's own drop");
  ctx.shownId = "b";
  touch(400);
  assert.ok(!classes.has("boxface") && tickets.dataset.side === "left",
    "a card with no box: the drawer stays on the left, so the right edge's pull does nothing");
  ctx.shownId = "a"; touch(400); classes.add("open");
  touch(2);
  assert.ok(classes.has("boxface"), "while out it keeps the face it went out with");
  classes.delete("open"); classes.add("boxface");
  ctx.openDrawer();
  assert.ok(!classes.has("boxface") && calls.at(-1) === "list", "the cards button always brings the list");
  ctx.apply({});
  assert.ok(calls.includes("apply") && calls.some(c => String(c).startsWith("/magic/body?box=a")),
    "every reading is the page's own, and then the box is read for the card on screen");
});

test("control shift period does for the box what control shift comma does for the list", async () => {
  const { ctx, classes, calls, drawer, anims, paneClasses, paneListeners } = phoneBoxScript(read("m.html"));
  const keys = [ctx.phoneShortcutActions, ctx.menuShortcutActions];
  assert.ok(keys.every(k => typeof k.boxDrawer === "function" && typeof k.cardsDrawer === "function"),
    "both keys are answered with the drawers shut and with one out");
  const press = (action, table = ctx.phoneShortcutActions) => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    calls.length = 0;
    table[action](e, { action, value: true });
    return e.prevented;
  };
  const tick = () => new Promise(r => setImmediate(r));
  const live = () => anims.filter(a => !a.cancelled && !a.done);
  const finishAll = async () => { for (const a of live()) { a.done = true; a.finish(); } await tick(); };
  const ends = (a, prop) => [a.keys[0][prop], a.keys.at(-1)[prop]].map(v => typeof v === "number" ? +v.toFixed(3) : v);
  // on a card with no box the period brings nothing and still takes the key,
  // so the phone types no period into the reply box; the card dips instead
  ctx.shownId = "b";
  assert.equal(press("boxDrawer"), true, "the key was left to type a period on a card with no box");
  assert.deepEqual(calls, []);
  assert.equal(ctx.menuOut(), null);
  assert.ok(paneClasses.has("nudge"), "the card did not dip");
  paneListeners.animationend({ animationName: "something else" });
  assert.ok(paneClasses.has("nudge"), "another animation's end took the dip off");
  paneListeners.animationend({ animationName: "cardnudge" });
  assert.ok(!paneClasses.has("nudge"), "the dip's end leaves it ready for the next press");
  // the period brings the box from the right, and again shuts it
  ctx.shownId = "a";
  assert.equal(press("boxDrawer"), true);
  assert.deepEqual(calls, ["show box from the right"]);
  assert.equal(press("boxDrawer", ctx.menuShortcutActions), true);
  assert.deepEqual(calls, ["close box from the right"]);
  await drawer.land();
  // the comma brings the list from the left
  press("cardsDrawer");
  assert.deepEqual(calls, ["show list from the left"]);
  // with the list out, the period swaps it for the box and the card stays down:
  // the drawer stays out, and first the list goes off to the left and fades as
  // it does when it shuts, at its own height, the card and the window still
  press("boxDrawer", ctx.menuShortcutActions);
  assert.deepEqual(calls, [], "the drawer was shut or opened again");
  assert.equal(ctx.menuOut(), ctx.tickets);
  let going = live();
  assert.deepEqual(going.map(a => a.part), ["drawer"], "only the drawer moves while the list goes");
  // (the stand-in spring is straight, 100ms long: the first millisecond with no
  // more than 2% of the way to go is the 99th)
  assert.deepEqual(ends(going[0], "transform"), ["translate3d(0px, -120px, 0px)", "translate3d(-297px, -120px, 0px)"]);
  assert.deepEqual(ends(going[0], "opacity"), [.999, .01]);
  assert.ok(!classes.has("boxface"), "the face changed before the list had gone");
  // once it is all but gone, the box comes in from the right as the drawer does
  // when it opens, and the card and the window glide to the box's own drop
  await finishAll();
  assert.ok(classes.has("boxface") && ctx.tickets.dataset.side === "right");
  let coming = live();
  assert.deepEqual(coming.map(a => a.part), ["drawer", "window", "card"]);
  assert.deepEqual(ends(coming[0], "transform"), ["translate3d(300px, -120px, 0px)", "translate3d(0px, -90px, 0px)"]);
  assert.deepEqual(ends(coming[0], "opacity"), [0, .999]);
  assert.deepEqual(ends(coming[1], "transform"), ["translate3d(0px, 120px, 0px)", "translate3d(0px, 90px, 0px)"]);
  assert.deepEqual(ends(coming[2], "transform"), ["translate(0px, 120px)", "translate(0px, 90px)"]);
  assert.ok(going.every(a => a.cancelled), "the list's going was left playing");
  await finishAll();
  assert.deepEqual(calls, ["settled"], "the drawer was not settled once the box was in");
  // and the comma swaps back the other way: the box goes off to the right, the
  // list comes in from the left, the card back to the list's drop
  press("cardsDrawer", ctx.menuShortcutActions);
  going = live();
  assert.deepEqual(ends(going[0], "transform"), ["translate3d(0px, -90px, 0px)", "translate3d(297px, -90px, 0px)"]);
  await finishAll();
  assert.ok(!classes.has("boxface") && ctx.tickets.dataset.side === "left");
  coming = live();
  assert.deepEqual(ends(coming[0], "transform"), ["translate3d(-300px, -90px, 0px)", "translate3d(0px, -120px, 0px)"]);
  assert.deepEqual(ends(coming[2], "transform"), ["translate(0px, 90px)", "translate(0px, 120px)"]);
  await finishAll();
  // a run or a key that comes while the list is going stops the swap where it
  // stands, and the box does not follow
  press("boxDrawer", ctx.menuShortcutActions);
  going = live();
  ctx.stopList();
  await tick();
  assert.ok(going.every(a => a.cancelled) && live().length === 0 && !classes.has("boxface"));
  // with reduced motion the face changes where it stands, the card still down
  ctx.LIST_CALM = { matches: true };
  press("boxDrawer", ctx.menuShortcutActions);
  assert.ok(classes.has("boxface") && live().length === 0 && ctx.menuOut() === ctx.tickets);
  assert.deepEqual(calls, ["settled"]);
  ctx.LIST_CALM = { matches: false };
  // the key of the face that is out shuts the drawer, as before
  press("boxDrawer", ctx.menuShortcutActions);
  assert.deepEqual(calls, ["close box from the right"]);
  await drawer.land();
  // shut, but still going back with its other face: it comes out again with the
  // asked-for face once it has landed
  press("cardsDrawer");
  press("cardsDrawer", ctx.menuShortcutActions);
  press("boxDrawer");
  assert.deepEqual(calls, []);
  await drawer.land();
  assert.deepEqual(calls, ["show box from the right"]);
  press("boxDrawer", ctx.menuShortcutActions);
  await drawer.land();
  // with the settings out, the period swaps them for the box at once, as the
  // comma swaps them for the list
  ctx.showMenu(ctx.settings);
  press("boxDrawer", ctx.menuShortcutActions);
  assert.deepEqual(calls, ["show box from the right"]);
  press("boxDrawer", ctx.menuShortcutActions);
  await drawer.land();
  ctx.showMenu(ctx.settings);
  press("cardsDrawer", ctx.menuShortcutActions);
  assert.deepEqual(calls, ["show list from the left"]);
  // the period on a card with no box, with the settings out, leaves them out
  press("cardsDrawer", ctx.menuShortcutActions);
  await drawer.land();
  ctx.showMenu(ctx.settings);
  ctx.shownId = "b";
  assert.equal(press("boxDrawer", ctx.menuShortcutActions), true);
  assert.deepEqual(calls, []);
  assert.equal(ctx.menuOut(), ctx.settings);
});

test("both pages load the box's script, and the board keeps the box out of the regions", () => {
  const html = read("index.html");
  assert.match(html, /<script src="\/magic-box\.js"><\/script>/);
  assert.match(read("m.html"), /<script src="\/card-logic\.js"><\/script>\s*<script src="\/magic-box\.js"><\/script>/);
  assert.match(html, /<section id="magicbox" class="magicbox">/);
  const fit = html.match(/const FIT_REGIONS = \[([^\]]*)\]/)[1];
  const regions = html.match(/const REGION_SEL = "([^"]*)"/)[1];
  assert.ok(!fit.includes("magicbox") && !regions.includes("magicbox"));
  assert.match(html, /MagicBox\.place\(/);
  assert.match(read("server.py"), /Route\("\/magic-box\.js", _static\("magic-box\.js"/);
  assert.match(read("tests/fixture-auth.cjs"), /'magic-box\.js'/);
});
