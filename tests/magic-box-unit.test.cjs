// Where a card's magic box stands, worked out without a browser: at full size
// nine tenths of the card's height and 1.14 times the width of an iPhone 13
// mini screen as tall as the card, smaller when the room right of the card is
// short, in the middle of that room so the gap to the card and the gap to the
// workspace's edge are equal, level with the card's middle, and not shown at
// all, never over the card, when the window has no room for it; inside that
// largest box, a picture in its own shape and never past its own size, words
// at their own height, hung from that box's top, under a top bar that keeps
// its height. Its look, read from the page's source: on the Mac the card's own
// face, corners and shadow but no edge line, under a white bar with no line
// under it; on the phone no box at all, a short bar parted from what it shows
// by the ticket list's own line; one cross, and a site that will not be framed
// as a square with its name in the middle; on the Mac whichever of the card
// and the box is held stands up and the other settles, and a box beside a
// lowered card sits level with it. And the page's wiring: the box is never one
// of the regions the fit, the layout or edit mode work on, a click or the focus
// says which of the two is held, and a page in the box never takes the keys by
// itself. People and agents know it as the magic box, `facilitator magic`.
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
const { TALL, WIDE, SHAPE, place } = api();
const PHONE = 375 / 812;
const close = (a, b, by = 1e-6) => Math.abs(a - b) < by;
// the card where a new board puts it (index.html --frame-*), in stage pixels
const CARD = { left: 1440 * 0.324, top: 900 * 0.0832, width: 1440 * 0.352, height: 900 * 0.832 };
const RIGHT = c => c.left + c.width;
const MIDDLE = r => r.top + r.height / 2;
// the workspace in a window w wide, as magicPlace hands it over: the frame's
// inner right edge 6.5px in from the window's side, the stage centred while
// the window is wider than it, and the fit's clearance of 16 as the least gap
const fitAt = (w, more = {}) => ({ scale: 1, tx: Math.max(0, (w - 1440) / 2), right: w - 6.5, clear: 16, ...more });
const edgeOf = fit => (fit.right - fit.tx) / fit.scale;
// a box beside its card: its own shape, the two gaps equal, the middles level
function besideRight(at, card, fit) {
  const gapCard = at.left - RIGHT(card), gapEdge = edgeOf(fit) - (at.left + at.width);
  assert.equal(at.shown, true);
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
  const at = place(CARD, fit);
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
  const at = place(CARD, fit);
  assert.ok(at.height < TALL * CARD.height, `height ${at.height}`);
  assert.ok(close(besideRight(at, CARD, fit), 16), "both gaps are the clearance");
  assert.ok(close(at.width, edgeOf(fit) - RIGHT(CARD) - 32));
});

test("at every window width the gaps stay equal, and the box only grows as the window does", () => {
  let last = 0;
  for (let w = 1235; w <= 1700; w += 7) {
    const fit = fitAt(w);
    const at = place(CARD, fit);
    besideRight(at, CARD, fit);
    assert.ok(at.width >= last - 1e-6, `smaller at ${w}`);
    last = at.width;
  }
  assert.ok(close(last, CARD.height * WIDE), "and stops at its full size");
});

test("a card made shorter or moved takes its box with it", () => {
  const fit = fitAt(1280);
  for (const card of [{ ...CARD, height: 520 }, { ...CARD, top: 180, height: 520 }, { ...CARD, left: 300 }]) {
    const at = place(card, fit);
    besideRight(at, card, fit);
  }
  const shorter = place({ ...CARD, height: 480 }, fit);
  assert.ok(close(shorter.height, TALL * 480), "a short enough card has a box nine tenths as tall as itself");
});

test("the room is read through the stage's scale and shift, in both panes", () => {
  const scaled = { scale: 0.8, tx: 20, right: 1100, clear: 16 };
  const at = place(CARD, scaled);
  // (1100 - 20) / .8 = 1350 on the stage, and the clearance is 16 screen pixels
  assert.ok(close(besideRight(at, CARD, scaled), 20), "16 on screen is 20 on a stage drawn at .8");
  const pane = { scale: 0.9, tx: -300, right: 1000, clear: 16 };   // the right pane
  besideRight(place(CARD, pane), CARD, pane);
});

test("with less than half the card's height of room beside it, it is not shown, and never stands over the card", () => {
  const at = place(CARD, fitAt(1100));
  assert.equal(at.shown, false);
  // a window just wider than the threshold keeps it beside the card
  const just = fitAt(1240);
  besideRight(place(CARD, just), CARD, just);
  // the threshold is half the card's height, exactly: one pixel either side
  // of the window where the box would be that tall
  const half = CARD.height / 2, at1 = RIGHT(CARD) + half * SHAPE + 2 * 16 + 6.5;
  assert.equal(place(CARD, fitAt(at1 + 1)).shown, true);
  assert.equal(place(CARD, fitAt(at1 - 1)).shown, false);
  // at every width from a phone's to past the full size, a box that is shown
  // stands right of the card with the clearance between them, and one that
  // is not shown asks for nothing it cannot have
  let seen = 0, gone = 0;
  for (let w = 400; w <= 1700; w += 3) {
    const fit = fitAt(w), at = place(CARD, fit);
    if (at.shown) {
      seen++;
      assert.ok(at.left >= RIGHT(CARD) + 16 - 1e-6, `over the card at ${w}`);
      assert.ok(at.height >= half - 1e-6, `too small to read at ${w}`);
      besideRight(at, CARD, fit);
    } else {
      gone++;
      assert.ok(Number.isFinite(at.width) && at.width >= 0 && Number.isFinite(at.left), `odd numbers at ${w}`);
    }
  }
  assert.ok(seen && gone, "both sides of the threshold were crossed");
});

test("the room is all it asks: the same card shows again in a wider window, and in a narrower one hides", () => {
  // place() keeps nothing between calls: what it says comes from the card and
  // the window alone, so the box is back the moment the window is wide enough
  const narrow = place(CARD, fitAt(1100)), wide = place(CARD, fitAt(1512)), again = place(CARD, fitAt(1100));
  assert.deepEqual([narrow.shown, wide.shown, again.shown], [false, true, false]);
  const tiny = place(CARD, { scale: 1, tx: 0, right: 700, clear: 16 });
  assert.equal(tiny.shown, false);
  assert.ok(tiny.width >= 0, "never a size below nothing");
});

// what the box shows, inside the largest box there is room for
const SIZED = (want, fit = fitAt(1512)) => ({ most: place(CARD, fit), at: place(CARD, fit, want), fit });
function sizedRight({ most, at, fit }) {
  assert.ok(at.width <= most.width + 1e-6 && at.height <= most.height + 1e-6, "never larger than the largest box");
  assert.ok(close(at.top, most.top), "its top on the largest box's top, not centred up and down");
  assert.equal(at.shown, most.shown);
  if (at.shown) {
    const gapCard = at.left - RIGHT(CARD), gapEdge = edgeOf(fit) - (at.left + at.width);
    assert.ok(close(gapCard, gapEdge), `gaps ${gapCard} and ${gapEdge}`);
  }
  return at;
}

test("a wide picture gets a wide, short box and a tall one a tall, narrow box, in its own shape", () => {
  const wide = sizedRight(SIZED({ width: 2000, height: 1000 }));
  assert.ok(close(wide.width / wide.height, 2) && close(wide.width, place(CARD, fitAt(1512)).width), "as wide as there is room");
  const tall = sizedRight(SIZED({ width: 600, height: 2400 }));
  assert.ok(close(tall.width / tall.height, 0.25) && close(tall.height, TALL * CARD.height), "as tall as there is room");
  const square = sizedRight(SIZED({ width: 1500, height: 1500 }));
  assert.ok(close(square.width, square.height));
});

test("a picture is never drawn past its own size, and a small one keeps its size", () => {
  const small = sizedRight(SIZED({ width: 200, height: 120 }));
  assert.deepEqual([small.width, small.height], [200, 120]);
  // the gaps are equal for the narrower width too
  assert.ok(small.left - RIGHT(CARD) > place(CARD, fitAt(1512)).left - RIGHT(CARD));
});

test("words take their own height up to the largest box, then scroll; a page or a site takes all of it", () => {
  const most = place(CARD, fitAt(1512));
  const short = sizedRight(SIZED({ height: 180 }));
  assert.deepEqual([short.width, short.height], [most.width, 180], "the full width, their own height");
  const long = sizedRight(SIZED({ height: 5000 }));
  assert.deepEqual(long, most, "no taller than the largest box, and then exactly where it stood");
  // a short one hangs from the largest box's top, which is 5% of the card's
  // height under the card's own top, and keeps its left and right as before
  assert.ok(close(short.top - CARD.top, 0.05 * CARD.height));
  assert.ok(short.top + short.height < MIDDLE(CARD), "well above the card's middle");
  assert.equal(short.left, most.left);
  assert.deepEqual(place(CARD, fitAt(1512), null), most, "a page or a site asks for nothing");
});

test("in a narrow window the picture is fitted inside the smaller box, and in no room it is not shown either", () => {
  assert.equal(sizedRight(SIZED({ width: 2000, height: 1000 }, fitAt(1280))).shown, true);
  assert.equal(sizedRight(SIZED({ width: 2000, height: 1000 }, fitAt(1100))).shown, false);
});

test("the page hands the box the workspace's own edges, the fit's clearance and what it shows", () => {
  const html = read("index.html");
  const start = html.indexOf("function magicPlace(){"), fn = html.slice(start, html.indexOf("\n}\n", start));
  assert.match(fn, /const fit = \{ scale: S, tx: stageTx, right: lim\.right \+ FRAME_CLEAR, clear: FRAME_CLEAR \};/);
  // no room beside the card: hidden where it is, before anything is sized
  // or asked of what it shows, and nothing else is done with it
  assert.match(fn, /const most = MagicBox\.place\(rect, fit\);\n  if \(!most\.shown\)\{ MB\.el\.style\.visibility = "hidden"; return; \}\n/);
  assert.match(fn, /MagicBox\.place\(rect, fit, MB\.view\.want\(most, S\)\)/);
  assert.match(fn, /visibility: MB\.view\.waiting\(\) \? "hidden" : ""/);
  assert.ok(!/floating|--cardbar-h/.test(fn), "a float is left in the placing");
  // still open: hiding it closes nothing and takes nothing off the page, and
  // every fit and every reading of the board place it again
  assert.ok(!/magicOff|magicClose|MB\.el\.classList\.remove/.test(fn), "hiding it puts it away");
  assert.match(html, /magicSync\(\);      \/\/ and the card's magic box follows the card/);
  assert.match(html, /function magicSync\(\)\{[\s\S]*?\n  else \{[\s\S]*?\n    magicPlace\(\);\n  \}\n\}/);
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
  assert.match(html, /MB\.view = magicView\(MB\.el, \{ placed: \(\) => magicPlace\(\), openSite: magicOpenSite, sized: true \}\);/);
  // an agent's page asks for the height it said, on the board that asks for it
  // (the phone's drawer does not), and is kept hidden a moment while it says it
  assert.match(want, /if \(kind === "html"\) return hooks\.sized && view\.page && view\.page\.height \? \{ height: view\.page\.height \+ edges \+ head \} : null;/);
  assert.ok(!/PB\.view = magicView\([^)]*sized/.test(read("m.html")), "the phone asks a page its height");
  assert.match(read("m.html"), /PB\.view = magicView\(PB\.el, \{ placed: \(\) => phoneMagicFit\(\),/);
});

test("a page says its own height only when asked, and the phone's page is as it was", () => {
  const box = api();
  const plain = box.pageDoc("<p>x</p>", "w");
  assert.ok(plain.endsWith('<script>addEventListener("load", () => parent.postMessage("w", "*"))</script><p>x</p>'));
  assert.ok(!/ResizeObserver/.test(plain));
  const sized = box.pageDoc("<p>x</p>", "w", true);
  assert.match(sized, /parent\.postMessage\(W \+ ' ' \+ h, '\*'\)/);
  assert.match(sized, /new ResizeObserver\(say\)\.observe\(document\.body\)/);
  // the measure is how far the page's own contents reach, not the frame's height
  assert.match(sized, /r\.selectNodeContents\(b\)/);
  assert.ok(!/scrollHeight|innerHeight|clientHeight/.test(sized));
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
  const fit = fitAt(1512), most = place(CARD, fit), bar = 34;
  const tall = place(CARD, fit, { width: 600, height: 2400, head: bar });
  assert.ok(close(tall.height, most.height), "as tall as the largest box, bar and all");
  assert.ok(close((tall.height - bar) / tall.width, 4), "the picture keeps its own shape under the bar");
  const small = place(CARD, fit, { width: 200, height: 120, head: bar });
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

test("the shared sheet's box has no frame, face or shadow: a short bar parted from what it holds by the ticket list's own line, and one cross, on both pages", () => {
  const html = read("index.html"), phone = read("m.html"), sheet = boxSheet(), block = code(boxBlock()), logic = read("card-logic.js");
  const box = code(sheet.match(/\n\.magicbox\{([^}]*)\}/)[1]);
  // no frame: no edge, no face, no corners and no shadow, in the box's own rule
  // or anywhere in its block but the site square's own tile, which is content
  assert.ok(!/background|border|radius|box-shadow/.test(box), "the box draws a frame of its own");
  assert.ok(!/box-shadow/.test(block), "something in the box casts a shadow");
  assert.ok(!/\.magicbox\.held|body\.lowered \.magicbox/.test(block), "a shadow state is left");
  // the board says where it stands and its words' inset, and gives it its face
  // and shadow apart from the sheet (the Mac's test below). it never floats
  // over the card, so it has no paper of its own for that
  const on = html.slice(html.indexOf("  body.focus #magicbox.on{"), html.indexOf("}", html.indexOf("  body.focus #magicbox.on{")));
  assert.match(on, /display:flex; position:fixed; z-index:1; --mb-inset:calc\(var\(--pad-x\)\*2\/3\)/);
  assert.ok(!/#magicbox[^{]*\.floating|\.magicbox[^{]*\.floating/.test(html), "a floating box is left");
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
  assert.match(line, /left:0; right:0; bottom:0; height:0;/);
  assert.match(line, /border-top:var\(--edge\) solid var\(--line\)$/);
  for (const page of [html, phone]) {
    const list = page.match(/  #tikhead::after\{([^}]*)\}/)[1].replace(/\s+/g, " ");
    assert.match(list, /content:""; position:absolute; pointer-events:none;/);
    assert.match(list, /left:0; right:0; height:0;/);
    assert.match(list, /border-top:var\(--edge\) solid var\(--line\);/);
  }
  // the bar stands at the box's top on the board, on the phone and in a
  // portrait window alike, the line along its foot: nothing in the sheet
  // or either page turns the box over or moves the bar to its foot
  assert.match(box, /flex-direction:column;/);
  assert.ok(!/column-reverse|--mb-flow|--mb-air-head|--mb-air-foot|--mb-line-top|--mb-line-foot|barfoot/.test(code(boxBlock())), "a way to put the bar at the foot is left");
  assert.ok(!/@media[^{]*portrait[^{]*\{[^@]*\.magicbox/.test(code(read("card-tokens.css"))), "a portrait window still turns the box over");
  for (const page of [html, phone]) assert.ok(!/barfoot|#magicbox[^{]*\{[^}]*column-reverse|#mbface[^{]*\{[^}]*column-reverse/.test(code(page)), "a page turns its box over");
  // words run out to the box's sides, the line's ends, with no frame to keep off
  assert.match(sheet, /\.magicbox \.mbtext\{padding:var\(--mb-lead\) 0 var\(--mb-inset, 16px\);/);
  // one cross, a button that closes the box, in the bar, on the board and on
  // the phone alike
  for (const [page, open] of [[html, '<section id="magicbox" class="magicbox">'], [phone, '<section id="mbface" class="magicbox"']]) {
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
  assert.match(sheet, /\.magicbox \.mbbody\{[^}]*margin:0 0 var\(--mb-air\)\}/);
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
  // the words' top padding is the lead, so the first line stands --mb-lead
  // under the bar's foot, its line, on both pages
  assert.match(sheet, /\.magicbox \.mbtext\{padding:var\(--mb-lead\) 0 /);
  // measured on the simulators: the card's title's capitals stand 19.2px under
  // the card's bar on the board and 17.4px on the phone; a first line's
  // capitals stand 6.1px (a heading) to 6.5px (plain words) under its top
  const box = sheet.match(/\n\.magicbox\{([^}]*)\}/)[1];
  const lead = +box.match(/--mb-lead:(\d+(?:\.\d+)?)px\b/)[1];
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
  // it sinks away first (the rise backwards), and is then taken off the page
  assert.match(fn, /if \(b && b\.magic\) b\.magic\.open = false;\s*magicSink\(\);/);
  assert.match(fn, /fetch\("\/magic\/close\?box=" \+ encodeURIComponent\(id\), \{ method: "POST" \}\)/);
  assert.match(html, /function magicSink\(\)\{[\s\S]*?magicRise\(-1, \(\) => \{ const id = MB\.id; magicOff\(\); MB\.plans\.delete\(id\); \}\);/);
  // and the agent's own close sinks it the same way, while anything else takes it off at once
  assert.match(html, /const shut = magicCard\(true\);\s*if \(shut && shut\.id === MB\.id\) magicSink\(\);\s*else magicOff\(\);/);
});

test("the box rises out of the page as it first comes, its lines with it, and faster once the owner is at it", () => {
  const html = read("index.html");
  assert.match(html, /const RISE_MS = 1000, RISE_FAST = 3;/);
  // what it holds follows the rise, and the lines' and tabs' strength too
  assert.match(html, /\n  #magicbox\.rising > \*\{opacity:var\(--rise\)\}/);
  assert.match(html, /MB\.el\.style\.setProperty\("--rise", p\.toFixed\(4\)\);\s*MB\.lines\.style\.opacity = MB\.tabs\.style\.opacity = p\.toFixed\(4\);/);
  // a click, a key or a scroll in the box while it rises hurries the rest
  assert.match(html, /if \(MB\.el && MB\.rise\.dir > 0 && MB\.el\.contains\(e\.target\)\) MB\.rise\.fast = RISE_FAST;/);
  assert.match(html, /for \(const type of \["pointerdown", "keydown", "wheel"\]\) addEventListener\(type, magicHurry/);
  // only a box that opened on the card on screen since the last reading of the
  // board rises: coming back to its card, or a new revision, shows it risen
  assert.match(html, /const was = MB\.known;\s*if \(lastState\)\{\s*MB\.known = new Set\(lastState\.boxes\.filter\(x => x\.magic && x\.magic\.open\)\.map\(x => x\.id\)\);/);
  assert.match(html, /magicLoad\(b\.id, b\.magic\.rev, !!was && !was\.has\(b\.id\)\)/);
  assert.match(html, /const t = id === MB\.id && MB\.rise\.raf \? MB\.rise\.t : fresh \? 0 : 1;/);
  assert.match(html, /function magicOff\(\)\{[\s\S]*?magicRiseStop\(\);\s*magicRiseSet\(1\);/);
  // the lines are behind the card: ahead of it on the page; the tabs over the
  // card and the box; the card's own edge colour, never the accent
  assert.ok(html.indexOf('<svg id="mblines"') < html.indexOf("<main>"));
  assert.ok(html.indexOf('<svg id="mbtabs"') > html.indexOf("</main>"));
  assert.match(html, /body\.focus #mbtabs\.on\{z-index:2\}/);
  const lines = html.slice(html.indexOf("// the lines from the card to its box, copied"), html.indexOf("if (MB.el){", html.indexOf("function magicDrone(")));
  assert.match(lines, /const ink = getComputedStyle\(document\.querySelector\("main"\)\)\.borderTopColor;/);
  assert.ok(!/--accent|#432BFF|#D9D1BE/i.test(lines));
});

// the three templates and the stroke, run outside the page on stand-ins
const linesCode = () => {
  const html = read("index.html");
  return html.slice(html.indexOf("function magicRoute("), html.indexOf("if (MB.el){", html.indexOf("function magicDrone(")));
};
// a card and a box as each sketch has them, in its own pixels (m1127 round 2)
const SKETCH = {
  ref1: { card: { left: 92.8, top: 85.3, width: 885.6, height: 1267.8 }, box: { left: 1018, top: 324, width: 462, height: 453.5 } },
  ref2: { card: { left: 45.6, top: 101.6, width: 669.7, height: 958.9 }, box: { left: 750, top: 274, width: 419, height: 345 } },
  ref3: { card: { left: 69.9, top: 126, width: 669.7, height: 958.8 }, box: { left: 775, top: 299, width: 418, height: 344 } },
};

test("each template puts its lines where its sketch has them, as shares of the card and the box", () => {
  const ctx = vm.createContext({});
  vm.runInContext(linesCode(), ctx);
  const near = (a, b, d = 1.5) => Math.abs(a - b) <= d;
  // ref1, drawn on its own card and box, lands on the sketch's own pixels
  let { card, box } = SKETCH.ref1;
  const one = ctx.magicRoute(0, card, box, 0);
  const [a, b] = one.paths;
  assert.ok(near(a[0][1], 206.8) && near(a[1][0], 1245.2), "ref1's top line: " + JSON.stringify(a));
  assert.ok(near(b[0][1], 1249.9) && near(b[1][0], 1075.5), "ref1's low line: " + JSON.stringify(b));
  assert.ok(near(a[0][0], card.left + card.width, 4) && near(a[2][1], box.top, 4) && near(b[2][1], box.top + box.height, 4));
  assert.equal(one.tabs.length, 0);
  ({ card, box } = SKETCH.ref2);
  const two = ctx.magicRoute(1, card, box, 0).paths[0];
  assert.ok(near(two[0][0], 639.7) && near(two[1][1], 62) && near(two[2][0], 774.7), "ref2: " + JSON.stringify(two));
  assert.equal(ctx.magicRoute(1, card, box, 0).tabs.length, 2, "ref2's two tabs");
  ({ card, box } = SKETCH.ref3);
  const three = ctx.magicRoute(2, card, box, 0).paths[0];
  assert.ok(near(three[0][0], 217.6) && near(three[1][1], 68.4) && near(three[2][0], 957.3), "ref3: " + JSON.stringify(three));
  // on the board, whose box's top stands 5% down the card, ref1's top line
  // keeps the sketch's share of the room above the box
  const boardCard = { left: 467, top: 75, width: 507, height: 749 }, boardBox = { left: 1024, top: 112.4, width: 394, height: 388 };
  const ya = ctx.magicRoute(0, boardCard, boardBox, 0).paths[0][0][1];
  assert.ok(near((ya - 75) / (112.4 - 75), .509, .01));
  // a template that cannot be drawn says so: no room above the box, or a
  // line that would leave the workspace
  assert.equal(ctx.magicRoute(0, boardCard, { ...boardBox, top: 80 }, 0), null);
  assert.equal(ctx.magicRoute(1, boardCard, boardBox, 60), null);
  assert.equal(ctx.magicRoute(2, boardCard, { ...boardBox, top: 20 }, 0), null);
});

test("a box draws one template picked at random, never the one before it, kept while it is open, and the nearest that fits", () => {
  const svg = () => ({ dataset: {}, innerHTML: "", classList: { add() {}, toggle() {} } });
  const MB = { plans: new Map(), last: -1, id: null, lines: svg(), tabs: svg() };
  const ctx = vm.createContext({ MB, Math, getComputedStyle: () => ({ borderTopColor: "rgb(202, 202, 202)", borderTopWidth: "0.5px" }),
    document: { querySelector: () => ({}) } });
  vm.runInContext(linesCode(), ctx);
  const card = { left: 467, top: 75, width: 507, height: 749 }, box = { left: 1024, top: 112.4, width: 394, height: 388 };
  const seen = [];
  for (let i = 0; i < 300; i++){
    MB.id = "c" + i;
    ctx.magicLines(card, box, 0);
    seen.push(MB.plans.get(MB.id));
  }
  assert.ok(seen.every((k, i) => i === 0 || k !== seen[i - 1]), "the same template twice in a row");
  for (const k of [0, 1, 2]) assert.ok(seen.filter(x => x === k).length > 60, "template " + k + " is rarely picked");
  // kept for its card while open, whatever the box does
  MB.id = "c5"; const kept = MB.plans.get("c5");
  ctx.magicLines(card, { ...box, height: 200 }, 0);
  assert.equal(MB.plans.get("c5"), kept);
  // a template that does not fit gives way to the nearest that does. ref1
  // with the box's top level with the card's has no room above the box, and
  // ref2 is drawn; with the box's top nearer ref2's line than it can go down
  // into, ref3, whose line runs higher; with the workspace's edge over both
  // lines, none is drawn, and no new shape either
  MB.plans.set("c5", 0);
  ctx.magicLines(card, { ...box, top: 80 }, 0);
  assert.equal(MB.lines.dataset.route, 1);
  ctx.magicLines(card, { ...box, top: 50 }, 0);
  assert.equal(MB.lines.dataset.route, 2);
  ctx.magicLines(card, { ...box, top: 80 }, 50);
  assert.equal(MB.lines.dataset.route, -1);
  // ref2's nearest is ref3, and ref3's ref2
  assert.equal(vm.runInContext("JSON.stringify(MAGIC_NEAR)", ctx), "[[0,1,2],[1,2,0],[2,1,0]]");
});

test("the lines are drawn as the Drone brush draws them: a straight core through the corners, beaded by dabs, never a zig-zag", () => {
  const ctx = vm.createContext({});
  vm.runInContext(linesCode(), ctx);
  const pts = [[10, 50], [10, 10], [300, 10], [300, 90]];
  const line = ctx.magicDrone(pts, 7);
  // the core runs straight through the corners and nowhere else
  assert.equal(line.core, "M10.00 50.00L10.00 10.00L300.00 10.00L300.00 90.00");
  // dabs a little over two pixels apart along the whole length, each of
  // radius .9 to 1.5 and at most .15 off the line
  const dabs = [...line.dabs.matchAll(/M([-\d.]+) ([-\d.]+)a([\d.]+)/g)].map(m => ({ x: +m[1] + +m[3], y: +m[2], r: +m[3] }));
  const length = 40 + 290 + 80;
  assert.ok(dabs.length > length / 3.4 && dabs.length < length / 2 + 2, dabs.length + " dabs");
  for (const d of dabs){
    assert.ok(d.r >= .9 && d.r <= 1.5, "radius " + d.r);
    const off = Math.min(Math.abs(d.x - 10), Math.abs(d.x - 300), Math.abs(d.y - 10));
    assert.ok(off <= .16, "a dab off the line by " + off);
  }
  // the weight of 2: a core under it and dabs a little over it, which on the
  // simulator measured 1.95 wide on average against ref1's 1.96
  const mean = dabs.reduce((s, d) => s + d.r, 0) / dabs.length;
  assert.equal(vm.runInContext("DRONE.core", ctx), 1.25);
  assert.ok(2 * mean > 2.2 && 2 * mean < 2.6, "dabs " + 2 * mean + " across");
  assert.equal(ctx.magicDrone(pts, 7).dabs, line.dabs, "the same line is drawn the same");
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

test("whichever of the card and the box is held stands up and the other settles, and nothing else changes", () => {
  const html = read("index.html");
  // the lighter shadow, one value for the card and the box: both of the raised
  // shadow's layers at about half strength, never so weak that the one that is
  // not selected looks to have lost its shadow (the old .06 did)
  const lighter = html.match(/\n  body\.focus\{--shade-lighter:([^}]*)\}/)[1];
  const layers = s => [...s.matchAll(/(\d+)px (\d+)px rgba\(60,45,20,([.\d]+)\)/g)].map(m => [+m[2], +m[3]]);
  const raisedLayers = layers(html.match(/\n  #magicbox\.held\{box-shadow:([^}]*)\}/)[1]);
  const lighterLayers = layers(lighter);
  assert.equal(lighterLayers.length, raisedLayers.length, "as many layers as the raised shadow");
  lighterLayers.forEach(([blur, alpha], i) => {
    assert.equal(blur, raisedLayers[i][0], "the same reach as the raised layer");
    assert.ok(alpha >= raisedLayers[i][1] * .45 && alpha <= raisedLayers[i][1] * .65, `layer ${i} is not about half the raised one`);
  });
  assert.ok(lighterLayers[0][1] > .06, "no fainter than the settled shadow that all but vanished");
  // the card steps back to it only while an open box is held and drawn, at the
  // settled rule's own weight, ahead of the lowered card's rule, so a lowered
  // card stays level
  const rule = "  body.focus:not(.home, .editmode):has(:where(#magicbox.on.held)) main{box-shadow:var(--shade-lighter)}";
  assert.ok(html.includes(rule));
  assert.ok(html.indexOf(rule) < html.indexOf("  body.focus.lowered main{box-shadow:none}"));
  // both ease over the card's own timing, and the shadow is all they change
  const card = html.slice(html.indexOf("  body.focus main{"), html.indexOf("}", html.indexOf("  body.focus main{")));
  assert.match(card, /transition:box-shadow \.2s;/);
  assert.match(html, /\n  #magicbox\{background:var\(--card\); border:var\(--edge\) solid var\(--line\); border-radius:7px;\s*box-shadow:var\(--shade-lighter\); transition:box-shadow \.2s\}/);
  const style = html.slice(0, html.indexOf("</style>"));
  const rules = [...style.matchAll(/\n  ([^\n{]*\.held[^\n{]*)\{([^}]*)\}/g)];
  assert.deepEqual(rules.map(r => r[1].trim()), ["body.focus:not(.home, .editmode):has(:where(#magicbox.on.held)) main", "#magicbox.held",
    "#magicbox.rising.held"], "the card's rule and the box's, and the box's as it rises");
  for (const [, , body] of rules) assert.match(body.trim(), /^box-shadow:[^;]*$/);
  // risen, the rising one is the held one exactly
  const rising = html.match(/\n  #magicbox\.rising\.held\{\s*box-shadow:([^}]*)\}/)[1];
  assert.equal(rising.replace(/calc\(([^)]*?) \* var\(--rise\)\)/g, "$1").replace(/\s+/g, " ").trim(),
    html.match(/\n  #magicbox\.held\{box-shadow:([^}]*)\}/)[1]);
  // the box's raised shadow is the card's own, the settled one the card's own settled
  const raised = html.match(/\n  #magicbox\.held\{box-shadow:([^}]*)\}/)[1];
  assert.ok(card.includes("box-shadow:" + raised + ";"), "the card's own raised shadow");
  // the box goes off the page settled; the agent's next revision keeps it held
  assert.match(html, /function magicOff\(\)\{\s*if \(!MB\.el\) return;\s*MB\.el\.classList\.remove\("on", "held", "over", "rising"\);/);
  // and risen, unless it was still rising or sinking, or is new on the card
  assert.match(html, /const held = id === MB\.id && MB\.el\.classList\.contains\("held"\);\s*const t = id === MB\.id && MB\.rise\.raf \? MB\.rise\.t : fresh \? 0 : 1;\s*magicOff\(\);\s*MB\.el\.classList\.toggle\("held", held\);\s*magicRiseSet\(t\);/);
});

// a selector's weight, for the plain ones these rules use: ids, then classes,
// then elements
const weight = selector => [(selector.match(/#[\w-]+/g) || []).length, (selector.match(/\.[\w-]+/g) || []).length,
  (selector.replace(/[#.][\w-]+/g, "").match(/[a-z][\w-]*/g) || []).length];
const heavier = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

test("the Mac's box has the card's face, edge and shadow; the phone's has no box; a lowered card's box sits level, held or not", () => {
  const html = read("index.html"), phone = read("m.html"), style = code(html.slice(0, html.indexOf("</style>")));
  // the board's box: the card's white, edge line, 7px corners and shadow
  const face = style.match(/\n  #magicbox\{background:var\(--card\); [^}]*\}/)[0];
  const card = html.slice(html.indexOf("  body.focus main{"), html.indexOf("}", html.indexOf("  body.focus main{")));
  assert.match(card, /border:var\(--edge\) solid var\(--line\); background:#fff; border-radius:7px;/);
  assert.match(face, /border:var\(--edge\) solid var\(--line\); border-radius:7px;/, "the card's own edge");
  assert.ok(!/outline/.test(face));
  // and that is the only edge any of the board's box rules draws
  const borders = style.match(/\n  #magicbox[^{]*\{[^}]*\}/g).join("").match(/border(?!-radius)[\w-]*:[^;}]*/g);
  assert.deepEqual(borders, ["border:var(--edge) solid var(--line)"]);
  // the bar is the card's white with no line under it, the cross's seat its white
  assert.match(style, /\n  #magicbox \.mbbar\{background:var\(--card\)\}/);
  assert.match(style, /\n  #magicbox \.mbbar::after\{display:none\}/);
  assert.match(style, /\n  #magicbox \.mbclose\{background:var\(--card\)\}/);
  assert.match(style, /\n  #magicbox \.mbclose:hover, #magicbox \.mbclose:active\{background:color-mix\(in srgb, #000 var\(--press\), var\(--card\)\)\}/);
  // its words keep the card answer's inset off the sides, and --mb-lead under the bar
  assert.match(style, /\n  #magicbox \.mbtext\{padding:var\(--mb-lead\) var\(--mb-inset, 16px\) var\(--mb-inset, 16px\)\}/);
  // the lowered card's rule outweighs every rule that shades the box, held or not
  const level = style.match(/\n  (body\.lowered #magicbox\.on)\{box-shadow:none\}/);
  assert.ok(level, "no rule for a box beside a lowered card");
  const shading = [...style.matchAll(/\n  ((?:body\.lowered )?#magicbox[^\n{ ]*)\{[^}]*box-shadow:[^}]*\}/g)].map(m => m[1]).filter(s => s !== level[1]);
  // the two, and the same two scaled by the rise as it comes and goes
  assert.deepEqual(shading, ["#magicbox", "#magicbox.held", "#magicbox.rising", "#magicbox.rising.held"], "the box's shadows");
  for (const s of shading) assert.ok(heavier(weight(level[1]), weight(s)) > 0, level[1] + " does not outweigh " + s);
  assert.ok(html.includes("  body.focus.lowered main{box-shadow:none}"));
  // the phone wears no box: no rule for #mbface or the shared sheet gives it a face, edge or shadow
  const sheet = code(boxBlock());
  assert.ok(!/box-shadow|\.held/.test(sheet), "the shared sheet shades the box");
  assert.ok(!/\.magicbox\{[^}]*(background|border)/.test(sheet.replace(/\s+/g, " ")), "the shared sheet dresses the box");
  const subjects = selectors => selectors.split(",").map(s => s.trim().split(/\s+/).pop());
  const own = [...code(phone.slice(0, phone.indexOf("</style>"))).matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .filter(m => /box-shadow|border|background/.test(m[2]) && subjects(m[1]).some(s => /^(#mbface|\.magicbox)\b/.test(s)));
  assert.deepEqual(own.map(m => m[1].trim()), [], "the phone dresses its box itself");
  assert.match(phone, /<section id="mbface" class="magicbox" aria-label="magic box">/);
});

test("clicking or focusing into the box holds it, and a page in it never takes the keys by itself", () => {
  const html = read("index.html");
  const last = 'addEventListener("blur", () => setTimeout(magicFocusCame));';
  const src = html.slice(html.indexOf("function magicHold("), html.indexOf(last) + last.length);
  const classes = new Set(["on"]), inBox = new Set(), on = {};
  const doc = { activeElement: null };
  const node = where => {
    const n = { where, isConnected: true, focused: 0, closest: sel => (sel === "main" && where === "card" ? {} : null),
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
  const held = () => classes.has("held");
  const [cover, frame, card, board] = [node("box"), node("box"), node("card"), node("board")];
  for (const type of ["pointerdown", "focusin", "pointerover", "pointermove", "keydown"])
    assert.ok(on[type].every(l => l.capture === true), type);
  // clicks and the focus moving
  fire("pointerdown", { target: cover }); assert.equal(held(), true, "a click in the box");
  fire("pointerdown", { target: card }); assert.equal(held(), false, "a click on the card");
  fire("pointerdown", { target: cover }); fire("pointerdown", { target: board });
  assert.equal(held(), false, "a click anywhere else");
  fire("focusin", { target: cover }); assert.equal(held(), true, "the focus moved into the box");
  fire("focusin", { target: card }); assert.equal(held(), false, "the focus moved into the card, to type");
  assert.equal(MB.back, card, "and the board knows where the owner was");
  // the owner types in the card, the pointer elsewhere: a page in the box takes
  // the keys, and they go straight back
  fire("pointermove", { target: board });
  assert.equal(MB.over, false);
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, card, "the keys are back in the card");
  assert.equal(card.focused, 1);
  assert.equal(held(), false, "and the box is not held for it");
  // the owner's own click: the pointer lands on the frame's cover first
  fire("pointerover", { target: cover });
  assert.equal(MB.over, true);
  assert.ok(classes.has("over"), "the cover comes off");
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, frame, "the keys stay in the frame");
  assert.equal(held(), true);
  // a Tab into the frame is the owner's too, for a second
  fire("pointerdown", { target: card }); fire("pointermove", { target: board });
  fire("keydown", { key: "Tab" });
  doc.activeElement = frame; fire("blur", {});
  assert.equal(held(), true, "a Tab");
  fire("pointerdown", { target: card });
  now += 2000;
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, card, "long after a Tab, the page's own doing");
  // nowhere to go back to: the frame lets go
  MB.back = null;
  doc.activeElement = frame; fire("blur", {});
  assert.equal(doc.activeElement, null);
  // a box that is not open is never held and never under the pointer
  classes.delete("on");
  fire("pointerdown", { target: cover }); assert.equal(held(), false);
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
  assert.match(view, /frame\.srcdoc = MagicBox\.pageDoc\(html, run\.word, !!hooks\.sized\)/);
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
      remove: c => classes.delete(c), add: c => classes.add(c) },
    getAnimations: () => drawer.runs, animate: animate("drawer"), querySelector: () => null };
  // what the drawer's lift reads (--tik-lift): the drawer's and its window's tops, the page's
  // top and padding, and the notch's foot (a probe the box script makes once)
  Object.assign(tickets, { style: { top: "0px", setProperty(name, value) { this[name] = value; } },
    getBoundingClientRect: () => ({ top: 0 }) });
  const pageEl = { style: { paddingTop: "0px" }, getBoundingClientRect: () => ({ top: 0 }) };
  const notch = { style: {}, getBoundingClientRect: () => ({ height: 0 }) };
  const settings = { dataset: { side: "right" } };
  // the box, 89px tall, whose words (16px of white under their last line) end
  // 8px over its foot, where the window they scroll in ends; and the list's
  // two parts, its names and its rows, the rows reaching 7px past the drawer
  const box = { offsetHeight: 89, style: {}, querySelector: () => ({ addEventListener() {} }), animate: animate("box"),
    getBoundingClientRect: () => ({ top: 0, bottom: 89, height: 89 }) };
  const words = { getBoundingClientRect: () => ({ bottom: 81 }), style: { paddingBottom: "16px" } };
  const body = { scrollHeight: 60, clientHeight: 60, querySelector: () => words, getBoundingClientRect: () => ({ bottom: 81 }) };
  const parts = { mbface: box, tikhead: { animate: animate("list names"), style: {} },
    tiklist: { animate: animate("list rows"), style: { marginBottom: "-7px" } } };
  const face = () => (classes.has("boxface") ? "box" : "list") + " from the " + tickets.dataset.side;
  const paneClasses = new Set(), paneListeners = {};
  const cardPane = { getAnimations: () => [], animate: animate("card"), offsetWidth: 0,
    classList: { add: c => paneClasses.add(c), remove: c => paneClasses.delete(c), contains: c => paneClasses.has(c) },
    addEventListener: (type, fn) => { paneListeners[type] = fn; } };
  const ctx = {
    document: { getElementById: id => parts[id], createElement: () => notch, body: { classList: { add() {} }, append() {} } },
    getComputedStyle: el => el.style,
    tickets, settings, innerWidth: 402, homeOpen: false, shownId: "a", activeOwner: "p", page: pageEl,
    tikwin: { getAnimations: () => [], animate: animate("window"), style: { top: "0px" } }, cardPane, tikArrows: [],
    // the page's run machinery, as far as the swap uses it: a straight spring of
    // 100ms, the drawer's 300px travel, the card's drop (120px under the list,
    // 90px under the box) and a stop that cancels what is playing
    LIST_KEYED: true, LIST_CALM: { matches: false }, LIST_FADE_TOP: .999, LIST_SETUP_MS: 200,
    listSpring: (from, to) => ({ ms: 100, at: t => from + (to - from) * Math.min(1, t / 100), velocity: () => 0 }),
    menuTravel: () => 300, menuSign: p => p.dataset.side === "right" ? -1 : 1,
    listDrop: 120, listRoom: 400, listPlay: [], listRun: null, ticketDrawerRun: 0, performance: { now: () => 0 },
    stopList: () => { classes.delete("swapface"); for (const a of ctx.listPlay) a.cancel(); ctx.listPlay = []; },
    settleTicketDrawer: () => calls.push("settled"), renderTickets() {},
    lastState: { boxes: [{ id: "a", owner: "p", done: false, magic: { open: true, rev: 1 } }, { id: "b", owner: "p", done: false }] },
    magicView: () => ({ body, want: () => ({ height: 89 }), waiting: () => false, draw() {}, clear() {} }),
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
    openDrawer: () => calls.push("list"), listSlack: () => 7, drawerPane: () => null,
    phoneShortcutActions: {}, menuShortcutActions: {},
    addEventListener: (type, fn, opts) => { (listeners[type] = listeners[type] || []).push({ fn, opts }); },
  };
  vm.runInContext(src, vm.createContext(ctx));
  return { ctx, classes, tickets, listeners, calls, drawer, anims, paneClasses, paneListeners, body, pageEl, notch };
}

test("on the phone the box comes down in the card list's own drawer, from the right, pulled the other way from the list", () => {
  const page = read("m.html");
  // the drawer wears the box in place of the list, and comes in from the right for it
  assert.match(page, /#tickets\.boxface > #tikhead, #tickets\.boxface > #tiklist\{display:none\}/);
  // while it changes face both are on show, the box laid over the list from the
  // drawer's top where it hangs alone
  assert.match(page, /#tickets\.swapface > #tikhead, #tickets\.swapface > #tiklist\{display:flex\}/);
  assert.match(page, /#tickets\.swapface > #mbface\{display:flex; flex:none; position:absolute; top:0; left:0; right:0; margin:0 auto\}/);
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
  const { ctx, classes, tickets, listeners, calls, body } = phoneBoxScript(page);
  const touch = x => { for (const l of listeners.touchstart) l.fn({ touches: [{ clientX: x }] }); };
  assert.ok(listeners.touchstart.every(l => l.opts.capture === true), "the face is chosen before the drawer's own gesture");
  touch(400);
  assert.ok(classes.has("boxface") && tickets.dataset.side === "right", "a right-edge pull on a card with a box");
  // the card goes down only as far as the box's words need, and stands A under
  // their last line (81, less their own 16px of white), as it stands A under the
  // list's foot. here, with nothing drawn and the notch at 0: the list's first mark
  // (14.9 under the drawer's top) is A = 14.9 under it, and the box, whose own mark
  // is 10.1 under its top, is moved down 4.8 to the list's. what the drawer spares
  // under that is the room (400) less the card's drop
  const under = foot => 400 - (foot + 14.9 + (14.9 - 10.1));
  assert.ok(Math.abs(ctx.listSlack() - under(81 - 16)) < 1e-9, "the card goes down only as far as the box's words need");
  // words that run on scroll in a window that ends 8px over the box's foot, and
  // the card stands as far under that window as under the list
  body.scrollHeight = 600;
  assert.ok(Math.abs(ctx.listSlack() - under(81)) < 1e-9, "the card stands under the window the words scroll in");
  body.scrollHeight = 60;
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
  // the dip is big enough to be seen: 14px down, 2.4px past home, in .44s (at
  // 7px in .32s it went by unseen on the phone)
  const sheet = read("m.html");
  const dip = sheet.slice(sheet.indexOf("@keyframes cardnudge{"), sheet.indexOf("#pane.nudge{"));
  assert.match(dip, /24%\{translate:0 calc\(14 \* var\(--u\)\);/);
  assert.match(dip, /60%\{translate:0 calc\(-2\.4 \* var\(--u\)\);/);
  assert.match(sheet, /#pane\.nudge\{animation:cardnudge \.44s\}/);
  assert.match(sheet, /@media \(prefers-reduced-motion:reduce\)\{ #pane\.nudge\{animation:none\} \}/);
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
  // the drawer stays out and holds still, both faces are on show, and they
  // cross. the list goes off to the left and fades as it does when it shuts,
  // and at the same moment the box sets out from the right as the drawer does
  // when it opens, so one or the other is always at least half in and the
  // space over the card is never empty; the card and the window glide to the
  // box's own drop from the same moment
  press("boxDrawer", ctx.menuShortcutActions);
  assert.deepEqual(calls, [], "the drawer was shut or opened again");
  assert.equal(ctx.menuOut(), ctx.tickets);
  assert.ok(classes.has("boxface") && classes.has("swapface") && ctx.tickets.dataset.side === "right",
    "the drawer takes its new face as the crossing starts, with both faces on show");
  const part = name => live().find(a => a.part === name);
  // (the stand-in spring is straight, 100ms long: the first millisecond with no
  // more than 2% of the way to go is the 99th)
  for (const name of ["list names", "list rows"]) {
    const going = part(name);
    assert.deepEqual(ends(going, "transform"), ["translate3d(0px, 0px, 0px)", "translate3d(-297px, 0px, 0px)"], name);
    assert.deepEqual(ends(going, "opacity"), [.999, .01], name);
    assert.deepEqual([going.opts.duration, going.opts.delay || 0, going.opts.fill], [99, 0, "both"], name);
  }
  let coming = part("box");
  assert.deepEqual(ends(coming, "transform"), ["translate3d(300px, 0px, 0px)", "translate3d(0px, 0px, 0px)"]);
  assert.deepEqual(ends(coming, "opacity"), [0, .999]);
  assert.deepEqual([coming.opts.delay || 0, coming.opts.fill], [0, "backwards"], "the box waited for the list to go");
  assert.deepEqual(ends(part("drawer"), "transform"), ["translate3d(0px, -120px, 0px)", "translate3d(0px, -90px, 0px)"]);
  assert.deepEqual(ends(part("window"), "transform"), ["translate3d(0px, 120px, 0px)", "translate3d(0px, 90px, 0px)"]);
  assert.deepEqual(ends(part("card"), "transform"), ["translate(0px, 120px)", "translate(0px, 90px)"]);
  assert.ok(["drawer", "window", "card"].every(name => !part(name).opts.delay), "the card glides from the moment the box sets out");
  await finishAll();
  assert.ok(!classes.has("swapface") && classes.has("boxface"), "the list was left on show once the box was in");
  assert.equal(live().length, 0, "something was left playing");
  assert.deepEqual(calls, ["settled"], "the drawer was not settled once the box was in");
  // and the comma swaps back the other way: the box goes off to the right while
  // the list comes in from the left, the card back to the list's drop
  press("cardsDrawer", ctx.menuShortcutActions);
  assert.ok(!classes.has("boxface") && classes.has("swapface") && ctx.tickets.dataset.side === "left");
  assert.deepEqual(ends(part("box"), "transform"), ["translate3d(0px, 0px, 0px)", "translate3d(297px, 0px, 0px)"]);
  coming = part("list rows");
  assert.deepEqual(ends(coming, "transform"), ["translate3d(-300px, 0px, 0px)", "translate3d(0px, 0px, 0px)"]);
  assert.equal(coming.opts.delay || 0, 0, "the list waited for the box to go");
  assert.deepEqual(ends(part("card"), "transform"), ["translate(0px, 90px)", "translate(0px, 120px)"]);
  await finishAll();
  assert.ok(!classes.has("swapface") && live().length === 0);
  // a run or a key that comes while the faces cross stops the swap, with the
  // new face alone in place
  press("boxDrawer", ctx.menuShortcutActions);
  const crossing = live();
  ctx.stopList();
  await tick();
  assert.ok(crossing.every(a => a.cancelled) && live().length === 0 && classes.has("boxface") && !classes.has("swapface"));
  press("cardsDrawer", ctx.menuShortcutActions);
  await finishAll();
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

test("people and agents know it as the magic box: the pages' labels, the command, its help, the runbook and the skill", () => {
  const phone = read("m.html"), board = read("index.html");
  assert.match(phone, /<section id="mbface" class="magicbox" aria-label="magic box">/);
  for (const page of [board, phone]) {
    assert.ok(!/side[ -]?note/i.test(page), "a page still says side note");
    assert.ok(/aria-label="Close the magic box"/.test(page), "the cross is not labelled for the magic box");
  }
  const cli = read("facilitator"), runbook = read("RUNBOOK.md"), skill = read(".agents/skills/facilitator/SKILL.md");
  assert.match(cli, /\n    elif cmd == "magic":\n        cmd_magic\(args\)\n/);
  assert.ok(!/cmd == "sidenote"/.test(cli), "the side note command is still taken");
  for (const [name, text] of [["facilitator", cli], ["RUNBOOK.md", runbook], ["SKILL.md", skill]]) {
    assert.ok(!/side[ -]?note/i.test(text), name + " still names a side note");
    assert.match(text, /facilitator magic CARD|facilitator magic m12/, name);
  }
  assert.match(runbook, /\n## The magic box\n/);
  assert.match(runbook, /\n## Seeing a card's magic box\n/);
  assert.match(skill, /the runbook's "The magic box" section/);
  // what the board says back to an agent, in the same name
  const server = read("server.py");
  assert.ok(!/side[ -]?note/i.test(server), "the server still says side note");
  for (const words of ["this card has no magic box", "the box would be empty", "the box could not be written",
    "a website box takes one web address on one line", "this card's box holds no picture"])
    assert.ok(server.includes(`"${words}"`), words);
  // the routes and the stored folder keep their names
  assert.match(server, /Route\("\/magic", _endpoint\(_post_magic/);
  assert.match(server, /MAGIC_DIR = HERE \/ "magic-boxes"/);
});

test("both faces start at one height, with one gap above and below: the list is lifted by half its difference, the box follows", () => {
  const { ctx, tickets, pageEl, notch, body } = phoneBoxScript(read("m.html"));
  const lift = () => { ctx.fitList(true); return tickets.style["--tik-lift"]; };
  // the page's top 0 and padding 40, the room 400, the drawer's top at 50, the notch's foot at 30;
  // the list's last ticket ends 360 under the drawer's top with 7 spare under it, so the card
  // stands at 40 + 400 - 7 = 433. the list's first mark (14.9 under its top) is 34.9 under the
  // notch and its foot 23 above the card: it goes up 5.95 and both gaps are A = 28.95
  pageEl.style.paddingTop = "40px"; tickets.style.top = "50px"; notch.getBoundingClientRect = () => ({ height: 30 });
  let ticketsEnd = 360;
  ctx.drawerPane = () => ({ children: [{ offsetParent: {}, getBoundingClientRect: () => ({ bottom: ticketsEnd }) }] });
  assert.equal(lift(), "5.95px");
  ticketsEnd = 100;
  assert.equal(lift(), "0.00px", "a list already nearer the notch than the card is not lowered");
  ticketsEnd = 360;
  // the box takes the list's place: its mark (10.1 under its top) at the list's, so it is 4.8
  // lower in its own terms, 5.95 - 4.8 of lift. its words end 65 under its top and the card
  // stands A = 28.95 under them: a drop of 50 - 1.15 + 65 + 28.95 - 40, the spare 400 less that
  ctx.drawerFace(true);
  assert.equal(lift(), "1.15px");
  const marks = { list: 50 + 14.9 - 5.95, box: 50 + 10.1 - 1.15 };
  assert.ok(Math.abs(marks.list - marks.box) < 1e-9, "one top for both faces");
  assert.ok(Math.abs(ctx.listSlack() - (400 - (50 - 1.15 + 65 + 28.95 - 40))) < 1e-9, "the card stands A under the box's words");
  // a box tall enough to need the card further down than the room allows stops it there
  body.scrollHeight = 600; body.getBoundingClientRect = () => ({ bottom: 380 });
  assert.equal(ctx.listSlack(), 0, "the card goes down no further than the room, as before");
  const page = read("m.html");
  assert.equal((page.match(/\(var\(--list-drop, 0px\) \+ var\(--tik-lift, 0px\)\)/g) || []).length, 2, "both sides' transforms carry the lift");
  assert.match(page, /padding-top:max\(0px, calc\(env\(safe-area-inset-top, 0px\) - \$\{NOTCH_GAP\}px\)\)/, "the notch's foot is read from the safe area");
});

test("a pull from the right edge on a card with no box dips the card once, and nothing else does", () => {
  const { ctx, listeners, paneClasses } = phoneBoxScript(read("m.html"));
  const fire = (type, e) => { for (const l of listeners[type] || []) l.fn(e); };
  const at = (x, y = 400) => ({ touches: [{ clientX: x, clientY: y }], timeStamp: 0 });
  const dipped = () => { const d = paneClasses.has("nudge"); paneClasses.clear(); return d; };
  const pull = (x0, x1, y1) => { fire("touchstart", at(x0)); fire("touchmove", at(x1, y1)); fire("touchend", { timeStamp: 0 }); return dipped(); };
  ctx.shownId = "b";
  assert.ok(pull(398, 300), "a swipe leftwards from the right edge");
  assert.ok(pull(398, 300), "and again, a dip each swipe");
  fire("touchstart", at(398)); fire("touchmove", at(300)); assert.ok(dipped());
  fire("touchmove", at(250)); assert.ok(!dipped(), "one dip a swipe");
  fire("touchend", { timeStamp: 0 });
  fire("touchstart", at(398)); fire("touchend", { timeStamp: 0 });
  assert.ok(!dipped(), "a tap at the edge");
  assert.ok(!pull(398, 400), "a pull rightwards");
  assert.ok(!pull(398, 396, 520), "a pull downwards");
  assert.ok(!pull(398, 394), "a finger that has not gone 6px");
  assert.ok(!pull(10, 100), "the left edge's pull");
  assert.ok(!pull(300, 200), "a swipe that does not begin at the edge");
  ctx.homeOpen = true;
  assert.ok(!pull(398, 300), "Home is on show");
  ctx.homeOpen = false; ctx.shownId = "a";
  assert.ok(!pull(398, 300), "a card with a box brings the drawer out and does not dip");
  ctx.shownId = "b";
  const mouse = (type, x) => fire(type, { button: 0, clientX: x, clientY: 400, timeStamp: 5000 });
  mouse("mousedown", 398); mouse("mousemove", 300); mouse("mouseup", 300);
  assert.ok(dipped(), "the mouse follows the same rule, once its touch's leftovers are past");
});

test("the Mac box's words can be selected and copied, and command+a picks only them", () => {
  const html = read("index.html");
  const optIn = html.match(/\.reply, \.mreply[^{]*\{\s*-webkit-user-select:text; user-select:text;/);
  assert.ok(optIn && /#magicbox \.mbtext/.test(optIn[0]), "the box's words opt back in to selection");
  assert.ok(/getSelection\(\)\.selectAllChildren\(words\)/.test(html), "command+a selects the box's words alone");
});
