// Where a card's magic box stands, worked out without a browser: at full size
// the size the owner set in the layout mock, 125/133 of the card's height tall
// and 67/133 of it wide, smaller when the room right of the card is
// short, in the middle of that room so the gap to the card and the gap to the
// workspace's edge are equal, level with the card's middle, and not shown at
// all, never over the card, when the window has no room for it; inside that
// largest box, a picture in its own shape and never past its own size, words
// at their own height, hung from that box's top, under a top bar that keeps
// its height. Its look, read from the page's source: on the Mac the card's own
// face, edge line, corners and shadow, under a white bar with no line under it;
// on the phone the same face, edge and corners with the board's faint shadow,
// the same white bar at the box's foot, and its drawn top and bottom edges as
// the drawer's gaps;
// one cross, and a site that will not be framed
// as a square with its name in the middle; on the Mac whichever of the card
// and the box is held wears the card's own shadow and the other the faint one at 60%, and a box beside a
// lowered card sits level with it, on the phone too. And the page's wiring: the box is never one
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
const { TALL, WIDE, SHAPE, GAP, place, fit: fitRoom } = api();
// the box the owner set in the layout mock (m1330), in stage pixels, beside the card there
const SET = { width: 385.92, height: 720, gap: 52.19 };
const close = (a, b, by = 1e-6) => Math.abs(a - b) < by;
// the card where a new board puts it (index.html --frame-*), in stage pixels
const CARD = { left: 1440 * 0.32, top: 900 * 0.0576, width: 1440 * 0.36, height: 900 * 0.8512 };
const RIGHT = c => c.left + c.width;
const MIDDLE = r => r.top + r.height / 2;
// the workspace in a window w wide, as magicPlace hands it over: the frame's
// inner right edge 6.5px in from the window's side, the stage centred while
// the window is wider than it, and the fit's clearance of 16 as the least gap
const fitAt = (w, more = {}) => ({ scale: 1, tx: Math.max(0, (w - 1440) / 2), right: w - 6.5, clear: 16, ...more });
const edgeOf = fit => (fit.right - fit.tx) / fit.scale;
// a box beside its card: its own shape, the two gaps equal (or, with the board at
// its full size, the gap to the card held at its share of the card's width and the
// gap to the edge the rest), the middles level
function besideRight(at, card, fit) {
  const gapCard = at.left - RIGHT(card), gapEdge = edgeOf(fit) - (at.left + at.width);
  assert.equal(at.shown, true);
  assert.ok(close(at.width / at.height, SHAPE), `shape ${at.width / at.height}`);
  const held = fit.scale >= 1 && close(gapCard, GAP * card.width) && gapEdge > gapCard;
  assert.ok(close(gapCard, gapEdge) || held, `gaps ${gapCard} and ${gapEdge}`);
  assert.ok(gapCard >= fit.clear / fit.scale - 1e-6, `gap ${gapCard} under the clearance`);
  assert.ok(close(MIDDLE(at), MIDDLE(card)), `middle ${MIDDLE(at)} against ${MIDDLE(card)}`);
  assert.ok(at.height <= TALL * card.height + 1e-6, "never taller than its share of the card");
  return gapCard;
}

test("the shape: the size set in the layout mock, as shares of the starting card's height", () => {
  assert.ok(close(TALL, SET.height / CARD.height), `tall ${TALL}`);
  assert.ok(close(WIDE, SET.width / CARD.height), `wide ${WIDE}`);
  assert.ok(close(SHAPE, SET.width / SET.height));
  // no size of its own: a card twice as tall, with room for it, has a box twice as big
  const tall = place({ ...CARD, height: CARD.height }, fitAt(3000));
  const half = place({ ...CARD, height: CARD.height / 2 }, fitAt(3000));
  assert.ok(close(tall.width, 2 * half.width) && close(tall.height, 2 * half.height));
});

test("in the Mac's 1512 window: the size and gap set in the layout mock, level with the card's middle", () => {
  const fit = fitAt(1512);
  const at = place(CARD, fit);
  assert.ok(close(at.width, SET.width), `width ${at.width}`);
  assert.ok(close(at.height, SET.height), `height ${at.height}`);
  const off = (CARD.height - SET.height) / 2;
  assert.ok(close(at.top - CARD.top, off), "the same off the card's top");
  assert.ok(close(CARD.top + CARD.height - (at.top + at.height), off), "as off its foot");
  const gap = besideRight(at, CARD, fit);
  assert.ok(close(gap, SET.gap, 0.01), `the gap set in the mock: ${gap}`);
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
  assert.ok(close(shorter.height, TALL * 480), "a short enough card has a box its share as tall as itself");
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

// place() as it was before the gap was held: the box centred in the room right of the card
function centred(card, fit, want) {
  const scale = fit.scale || 1, edge = (fit.right - fit.tx) / scale, clear = (fit.clear || 0) / scale;
  const right = card.left + card.width, room = edge - right;
  let width = Math.max(0, Math.min(card.height * WIDE, room - 2 * clear)), height = width / SHAPE;
  const shown = height >= card.height / 2, top = card.top + card.height / 2 - height / 2;
  ({ width, height } = fitRoom({ width, height }, want));
  return { left: right + (room - width) / 2, top, width, height, shown };
}
const WANTS = [undefined, null, { height: 150 }, { height: 900 }, { width: 200, height: 120, head: 34 }, { width: 3600, height: 1800, head: 34 }];

test("up to the laptop's window, and wherever the board is shrunk to fit, the box stands exactly where it did", () => {
  // the board at its full size, in a window no wider than the laptop's: the centred gap is
  // never past its share, so nothing is held. one pixel wider it is
  // (spread into plain objects: place() answers from the script's own realm)
  for (const want of WANTS) for (let x = 400; x <= 1512; x++)
    assert.deepEqual({ ...place(CARD, fitAt(x), want) }, centred(CARD, fitAt(x), want), `moved at ${x} wide`);
  assert.notDeepEqual({ ...place(CARD, fitAt(1513)) }, centred(CARD, fitAt(1513)), "held from the next pixel on");
  // the board shrunk to fit: any window, however wide, keeps the centring as it was
  const cards = [CARD, { ...CARD, left: 300 }, { ...CARD, top: 180, height: 520 }, { ...CARD, width: 420 }];
  for (const card of cards) for (const want of WANTS) {
    for (const scale of [0.5, 0.8, 0.853, 0.99]) for (const x of [900, 1366, 1512, 2045, 2560, 3008]) {
      const fit = { scale, tx: Math.max(0, (x - 1440 * scale) / 2), right: x - 6.5, clear: 16 };
      assert.deepEqual({ ...place(card, fit, want) }, centred(card, fit, want), `moved at scale ${scale}, ${x} wide`);
    }
  }
});

test("on a window wider than the laptop's the gap to the card stays the same share of the card's width", () => {
  const laptop = place(CARD, fitAt(1512)), share = (laptop.left - RIGHT(CARD)) / CARD.width;
  assert.ok(share <= GAP && GAP - share < 1e-3, `the laptop's gap is ${share} of the card, held at ${GAP}`);
  for (const w of [1513, 1600, 1920, 2045, 2560, 3008, 5120]) {
    const fit = fitAt(w), at = place(CARD, fit);
    assert.ok(close((at.left - RIGHT(CARD)) / CARD.width, GAP), `${w} wide`);
    assert.ok(close(at.width, laptop.width) && close(at.top, laptop.top) && close(at.height, laptop.height), "same size and height");
    assert.ok(edgeOf(fit) - (at.left + at.width) > at.left - RIGHT(CARD), "the rest of the room is to the edge");
  }
  // a card of another width: the same share of its own width
  for (const width of [300, 700]) {
    const card = { ...CARD, width }, at = place(card, fitAt(3000));
    assert.ok(close((at.left - RIGHT(card)) / width, GAP), `card ${width} wide`);
  }
  // what the box shows, smaller than the whole box, stays in the middle of the whole box's place
  const whole = place(CARD, fitAt(3000)), small = place(CARD, fitAt(3000), { width: 200, height: 120, head: 34 });
  assert.ok(close(small.left + small.width / 2, whole.left + whole.width / 2), "centred in the whole box");
  assert.ok(close(whole.left - RIGHT(CARD), GAP * CARD.width));
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
  // a short one hangs from the largest box's top, which is half of what the
  // box leaves of the card's height under the card's own top, and keeps its
  // left and right as before
  assert.ok(close(short.top - CARD.top, (1 - TALL) / 2 * CARD.height));
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
  const roomAt = html.indexOf("function magicRoom(){"), room = html.slice(roomAt, html.indexOf("\n}\n", roomAt));
  assert.match(room, /const fit = \{ scale: S, tx: stageTx, right: lim\.right \+ FRAME_CLEAR, clear: FRAME_CLEAR \};/);
  assert.match(room, /return \{ S, sr, rect, fit, most: MagicBox\.place\(rect, fit\) \};/);
  // no room beside the card: hidden where it is, before anything is sized
  // or asked of what it shows, and nothing else is done with it
  assert.match(fn, /const room = magicRoom\(\);\n  if \(!room\)\{ MB\.el\.style\.visibility = "hidden"; return; \}\n  const \{ S, rect, fit, most \} = room;\n  if \(!most\.shown\)\{ MB\.el\.style\.visibility = "hidden"; return; \}\n/);
  assert.match(fn, /MagicBox\.place\(rect, fit, MB\.view\.want\(most, S\)\)/);
  // shown, it draws the line to the card from the card's and the box's own
  // rectangles, with no workspace edge to keep it under
  assert.match(fn, /magicLine\(rect, at\);\n  boxRise\(MB\);/);
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
  assert.match(html, /MB\.view = magicView\(MB\.el, \{ placed: \(\) => magicPlace\(\), openSite: magicOpenSite, sized: true,/);
  // an agent's page asks for the height it said, on the board that asks for it
  // (the phone's drawer does not), or a height already known for it at the
  // box's width, and is kept hidden a moment while it says it
  assert.match(want, /if \(!hooks\.sized \|\| !run\) return null;\s*if \(!run\.height && hooks\.pageHeight\) run\.height = hooks\.pageHeight\(room\.width - edges\) \|\| 0;\s*return run\.height \? \{ height: run\.height \+ edges \+ head \} : null;/);
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
  // (the page's scroll words, which come after, read how tall it and its window are)
  assert.ok(!/scrollHeight|innerHeight|clientHeight/.test(sized.slice(0, sized.indexOf("const R = "))));
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
  const on = html.slice(html.indexOf("  body.focus :is(#magicbox, #pipebox).on{"), html.indexOf("}", html.indexOf("  body.focus :is(#magicbox, #pipebox).on{")));
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
  assert.ok(!/background|box-shadow|border(?!-radius)/.test(bar), "the bar paints something of its own");
  assert.match(bar, /border-radius:calc\(var\(--mb-round\) - var\(--edge\)\) calc\(var\(--mb-round\) - var\(--edge\)\) 0 0/, "the bar keeps inside the box's rounder top corners");
  assert.match(box, /--mb-bar:calc\(var\(--mb-x\) \+ 2 \* var\(--mb-gap\)\);/);
  const own = phone.match(/  #mbface\{display:none;([^}]*)\}/)[1];
  assert.ok(!/--mb-bar/.test(own), "the phone sets its own bar, apart from the seat and the gap");
  assert.match(read("card-tokens.css"), /--cardbar-h:34px;/);
  for (const [where, seat, gap] of [["board", box.match(/--mb-x:(\d+)px;/), box.match(/--mb-gap:([\d.]+)px;/)],
                                    ["phone", own.match(/--mb-x:calc\((\d+) \* var\(--u\)\);/), own.match(/--mb-gap:calc\(([\d.]+) \* var\(--u\)\);/)]]) {
    const x = +seat[1], g = +gap[1], height = x + 2 * g;
    assert.equal(height, 30, where + ": the bar keeps its height, so the circle stays centred where it was");
    assert.equal(g + x / 2, (height - x) / 2 + x / 2, where + ": the cross's middle is not as far from the edge as from the side");
    assert.ok(g >= 5, where + ": the seat stands closer than 5px to the box's edges and the line");
    assert.ok(height < 34, where + ": the box's bar is no shorter than the card's");
    assert.ok(x >= 10 + 2 * 3, where + ": the seat leaves under 3px about the 10px mark");
  }
  // the phone's cross stands half as far again from the box's side and foot, in the page's own
  // units, with the bar's height as it was, and the expand button as far from the other side;
  // the board's cross is left where it is
  assert.match(own, /--mb-seat:calc\(1\.5 \* var\(--mb-gap\) \+ \.5 \* var\(--edge\)\)/);
  assert.match(phone, /#mbface \.mbbar\{padding:0 var\(--mb-seat\)\}/);
  assert.match(phone, /#mbface :is\(\.mbclose, \.mbgrow\)\{top:calc\(var\(--mb-gap\) - var\(--mb-seat\)\)\}/);
  assert.ok(!/--mb-seat/.test(sheet + html), "the board's cross is moved");
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
  // the bar stands at the box's top on the board, in a portrait window too,
  // and at its foot on the phone, where the markup puts it after what the box
  // holds: nothing in the sheet or either page turns the box over in its
  // styles, and nothing moves the board's bar
  assert.match(box, /flex-direction:column;/);
  assert.ok(!/column-reverse|--mb-flow|--mb-air-head|--mb-air-foot|--mb-line-top|--mb-line-foot|barfoot/.test(code(boxBlock())), "a way to put the bar at the foot is left");
  assert.ok(!/@media[^{]*portrait[^{]*\{[^@]*\.magicbox/.test(code(read("card-tokens.css"))), "a portrait window still turns the box over");
  for (const page of [html, phone]) assert.ok(!/barfoot|#magicbox[^{]*\{[^}]*column-reverse|#mbface[^{]*\{[^}]*column-reverse/.test(code(page)), "a page turns its box over");
  const order = (page, open) => { const s = page.slice(page.indexOf(open), page.indexOf("</section>", page.indexOf(open)));
    return [s.indexOf('<div class="mbbar">'), s.indexOf('<div class="mbbody">')]; };
  const [boardBar, boardBody] = order(html, '<section id="magicbox" class="magicbox">');
  assert.ok(boardBar > 0 && boardBar < boardBody, "the board's bar is not at its box's top");
  const [phoneBar, phoneBody] = order(phone, '<section id="mbface" class="magicbox"');
  assert.ok(phoneBody > 0 && phoneBody < phoneBar, "the phone's bar is not at its box's foot");
  // words run out to the box's sides, the line's ends, with no frame to keep off
  assert.match(sheet, /\.magicbox \.mbtext\{padding:var\(--mb-lead\) 0 var\(--mb-inset, 16px\);/);
  // one cross, a button that closes the box, at the bar's right, and at its left
  // the green button that expands it, on the board and on the phone alike
  for (const [page, open] of [[html, '<section id="magicbox" class="magicbox">'], [phone, '<section id="mbface" class="magicbox"']]) {
    const section = page.slice(page.indexOf(open), page.indexOf("</section>", page.indexOf(open)));
    assert.ok(section.length > 0, open);
    const bar = section.slice(section.indexOf('<div class="mbbar">'), section.indexOf("</div>", section.indexOf('<div class="mbbar">')));
    assert.equal(bar.trim().split("\n").slice(1).map(l => l.trim()).join(""),
      '<button type="button" class="mbgrow" aria-label="Expand the magic box"></button>' +
      '<button type="button" class="mbclose" aria-label="Close the magic box"></button>');
    assert.ok(!/mblight/.test(page), "a light is left on the page");
  }
  // its mark is drawn once, by the view both pages share, and it is the card
  // bar's own cross (.xbtn): two bars --bar-mark long and --cross-weight of
  // that thick, round ends, at 45 degrees. the svg is --bar-mark square on a 10
  // grid, so its stroke is 10 * 1.2 / 9 thick and each stroke's centre line is
  // the bar's length less that thickness, laid at 45 degrees about the middle
  const cross = logic.match(/const MAGIC_CROSS = ('[^;]*);/)[1];
  assert.match(cross, /viewBox="0 0 10 10"/);
  assert.match(cross, /stroke-linecap="round"/);
  assert.ok(Math.abs(+cross.match(/stroke-width="([\d.]+)"/)[1] - 10 * 1.2 / 9) < 1e-3, "the cross is not as thick as the card's");
  const reach = +cross.match(/M([\d.]+)/)[1], half = (10 - 10 * 1.2 / 9) / 2 / Math.SQRT2;
  assert.ok(Math.abs((5 - reach) - half) < 1e-3, "the cross is not as long as the card's");
  assert.match(cross, new RegExp("M" + reach + " " + reach + "L" + (10 - reach) + " " + (10 - reach) + "M" + (10 - reach) + " " + reach + "L" + reach + " " + (10 - reach)));
  assert.match(logic, /const cross = el\.querySelector\("\.mbclose"\);\s*if \(cross\) cross\.innerHTML = MAGIC_CROSS;/);
  assert.match(sheet, /\.magicbox \.mbclose svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/);
  for (const page of [html, phone]) assert.match(page, /width:var\(--bar-mark\); height:var\(--cross-t\); background:#1e1e1e;/);
  const seat = sheet.match(/\.magicbox \.mbclose\{([^}]*)\}/)[1];
  assert.match(seat, /width:var\(--mb-x\); height:var\(--mb-x\); padding:0; border:none; border-radius:50%;/);
  assert.match(seat, /background:var\(--mb-pink\); color:#1e1e1e;/);
  assert.match(sheet, /\.magicbox \.mbclose:hover, \.magicbox \.mbclose:active\{background:color-mix\(in srgb, #000 var\(--press\), var\(--mb-pink\)\)\}/);
  // the circle is a solid soft red, and the mark keeps its ink
  assert.match(box, /--mb-pink:#FF7A72\s*$/);
  assert.ok(!/--mb-pink-ink/.test(sheet + read("index.html") + read("m.html")), "no ink of its own for the mark");
  assert.ok(sheet.length > 1000 && !/--accent/.test(sheet), "never the accent");
});

test("a page an agent made, or a site, runs to the box's far edge with no white kept beside it; words and pictures are as they were", () => {
  const sheet = read("card-tokens.css"), phone = read("m.html");
  const edge = '.mbbody:is([data-kind="html"], [data-kind="url"]):has(> .mbframe){margin:0}';
  // the board's box keeps its air under what it holds, the phone's over it: a page with a paper of its
  // own wore the box's white there as a band, across its last line on the board
  assert.ok(sheet.includes(".magicbox " + edge));
  assert.ok(phone.includes("#mbface " + edge));
  assert.ok(sheet.indexOf(".magicbox " + edge) > sheet.indexOf(".magicbox .mbbody{flex:1;"), "after the rule it undoes");
  assert.ok(phone.indexOf("#mbface " + edge) > phone.indexOf("#mbface .mbbody{margin:var(--mb-air) 0 0;"), "and on the phone");
  // words and pictures keep what they had
  assert.match(sheet, /\.magicbox \.mbbody\{[^}]*margin:0 0 var\(--mb-air\)\}/);
  assert.ok(!/data-kind="(text|markdown)"\][^{]*\{margin/.test(sheet + phone));
  // a page has no fade of its own to paint white: the ramp is on words alone, and the page is clipped
  // to the box's rounded foot by the body it stands in
  assert.ok(!/data-kind="html"\][^{]*\{[^}]*mask/.test(sheet));
  assert.ok(sheet.includes(".magicbox .mbbody:last-child{border-radius:0 0 "));
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
  // the lead of the scroll on the bar's side takes no word under the bar, so it
  // is not counted: at the top on the board, at the foot on the phone, whose bar
  // is the box's last part
  assert.match(view, /const foot = !!view\.bar && el\.lastElementChild === view\.bar;/);
  assert.match(view, /view\.lead = parseFloat\(getComputedStyle\(words\)\[foot \? "paddingBottom" : "paddingTop"\]\) \|\| 0;/);
  assert.match(view, /const up = Math\.min\(Math\.max\(0, Math\.round\(b\.scrollTop - \(foot \? 0 : lead\)\)\), view\.fade\);/);
  assert.match(view, /const down = Math\.min\(Math\.max\(0, Math\.round\(b\.scrollHeight - b\.clientHeight - b\.scrollTop - \(foot \? lead : 0\)\)\), view\.fade\);/);
  assert.match(view, /view\.body\.addEventListener\("scroll", bands, \{ passive: true \}\);/);
  assert.match(logic, /view\.body\.appendChild\(prose\);\s*if \(sized\) sized\.observe\(prose\);\s*bands\(\);/);
  // and the box asks for that white with what it shows, so words that fit
  // still fit, and nothing of a picture is lost to it
  assert.match(logic, /head = view\.bar\.offsetHeight \+ \(parseFloat\(air\.marginTop\) \|\| 0\) \+ \(parseFloat\(air\.marginBottom\) \|\| 0\);/);
});

test("the words start a card's own 12px under the bar, a heading first or not", () => {
  const sheet = boxSheet(), phone = read("m.html");
  // the first line keeps no top margin of its own: a heading's would add a
  // line's worth of white over it
  assert.match(sheet, /\.magicbox \.mbtext > :first-child\{margin-top:0\}/);
  // the words' top padding is the lead, so the first line stands --mb-lead
  // under the bar's foot, its line, on both pages
  assert.match(sheet, /\.magicbox \.mbtext\{padding:var\(--mb-lead\) 0 /);
  // measured on the simulators: a first line's capitals stand 6.1px (a
  // heading) to 6.5px (plain words) under its top, and a card keeps 12px over
  // its first line (.head's top padding), so the capitals stand 12px under
  // the bar
  const box = sheet.match(/\n\.magicbox\{([^}]*)\}/)[1];
  const lead = +box.match(/--mb-lead:(\d+(?:\.\d+)?)px\b/)[1];
  assert.ok(Math.abs(lead + 6.1 - 12) < .6 && Math.abs(lead + 6.5 - 12) < .6, "the board's lead does not put the first line's capitals 12px under the bar");
  const own = phone.match(/  #mbface\{display:none;([^}]*)\}/)[1];
  const phoneLead = +own.match(/--mb-lead:calc\((\d+(?:\.\d+)?) \* var\(--u\)\)/)[1] * .984;
  assert.ok(Math.abs(phoneLead + 6.1 - 12) < .6 && Math.abs(phoneLead + 6.5 - 12) < .6, "the phone's lead does not put the first line's capitals 12px under the bar");
});

// the view's two bands, worked on a stand-in body: none at rest, the top one as
// the words scroll, capped at the fuzz's depth, and none at the end of the scroll
test("the box's bands follow the words' scroll, capped at the fuzz's depth", () => {
  const logic = read("card-logic.js");
  const src = logic.slice(logic.indexOf("const MAGIC_CROSS = "), logic.indexOf("// a site's name as the site gives it"))
    + logic.slice(logic.indexOf("function magicView("), logic.indexOf("\n}\n", logic.indexOf("function magicView(")) + 3);
  const props = {}, listeners = {};
  const words = {};   // the words keep a 6px lead over their first line
  const body = { dataset: {}, scrollTop: 0, scrollHeight: 600, clientHeight: 200, textContent: "",
    style: { setProperty: (k, v) => { props[k] = v; } },
    addEventListener: (type, fn) => { listeners[type] = fn; }, appendChild() {}, querySelector: s => s === ".mbtext" ? words : null };
  const cross = { innerHTML: "" };
  const el = { querySelector: s => s === ".mbbody" ? body : s === ".mbclose" ? cross : {} };
  const ctx = vm.createContext({ getComputedStyle: e => e === words ? { paddingTop: "6px" } : { getPropertyValue: () => "22px" },
    addEventListener() {}, h() {}, MagicBox: {} });
  vm.runInContext(src, ctx);
  ctx.magicView(el);
  assert.match(cross.innerHTML, /^<svg viewBox="0 0 10 10"/, "the cross is drawn into the bar's button");
  listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "0px", "--downband": "22px" }, "at the top: no band over the words' top, the full band at the foot");
  body.scrollTop = 6; listeners.scroll();
  assert.equal(props["--upband"], "0px", "the lead's worth of scroll takes no word under the bar, so no band");
  body.scrollTop = 15; listeners.scroll();
  assert.equal(props["--upband"], "9px", "the top band follows the scroll past the lead");
  body.scrollTop = 120; listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "22px", "--downband": "22px" }, "capped at the fuzz's depth");
  body.scrollTop = 400; listeners.scroll();
  assert.equal(props["--downband"], "0px", "at the end of the scroll no band at the foot");
});

// the phone's box, its bar at its foot: the same body with the words' 6px lead
// under their last line, over the bar. the far end, the top, has the ticket
// list's plain band, and the foot counts only words gone under the bar
test("with the bar at the box's foot the bands turn over: a plain one at the top, and none at the foot until words go under the bar", () => {
  const logic = read("card-logic.js");
  const src = logic.slice(logic.indexOf("const MAGIC_CROSS = "), logic.indexOf("// a site's name as the site gives it"))
    + logic.slice(logic.indexOf("function magicView("), logic.indexOf("\n}\n", logic.indexOf("function magicView(")) + 3);
  const props = {}, listeners = {};
  const words = {};
  const body = { dataset: {}, scrollTop: 0, scrollHeight: 600, clientHeight: 200, textContent: "",
    style: { setProperty: (k, v) => { props[k] = v; } },
    addEventListener: (type, fn) => { listeners[type] = fn; }, appendChild() {}, querySelector: s => s === ".mbtext" ? words : null };
  const bar = {}, cross = { innerHTML: "" };
  const el = { lastElementChild: bar, querySelector: s => s === ".mbbody" ? body : s === ".mbclose" ? cross : s === ".mbbar" ? bar : {} };
  const ctx = vm.createContext({ getComputedStyle: e => e === words ? { paddingTop: "16px", paddingBottom: "6px" } : { getPropertyValue: () => "22px" },
    addEventListener() {}, h() {}, MagicBox: {} });
  vm.runInContext(src, ctx);
  ctx.magicView(el);
  listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "0px", "--downband": "22px" }, "at rest: nothing over the top, the words under the bar at the foot");
  body.scrollTop = 9; listeners.scroll();
  assert.equal(props["--upband"], "9px", "the top's band is the list's plain one, from the first pixel of scroll");
  body.scrollTop = 390; listeners.scroll();
  assert.equal(props["--downband"], "4px", "the foot's band counts what is left past the lead");
  body.scrollTop = 394; listeners.scroll();
  assert.equal(props["--downband"], "0px", "the last lead's worth of scroll takes no word under the bar");
  body.scrollTop = 400; listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "22px", "--downband": "0px" }, "at the end: the top band capped, none at the foot");
  // words that fit wear no band at either end
  body.scrollTop = 0; body.scrollHeight = 200; listeners.scroll();
  assert.deepEqual({ ...props }, { "--upband": "0px", "--downband": "0px" });
});

test("the cross puts the box away as the agent's close does, and the board keeps what it held", () => {
  const html = read("index.html");
  assert.match(html, /MB\.el\.querySelector\("\.mbclose"\)\.addEventListener\("click", \(\) => magicClose\(\)\)/);
  const fn = html.slice(html.indexOf("function magicClose(){"), html.indexOf("function magicPlace(){"));
  // it sinks away first (the rise backwards), and is then taken off the page
  assert.match(fn, /if \(b && b\.magic\) b\.magic\.open = false;\s*magicSink\(\);/);
  assert.match(fn, /fetch\("\/magic\/close\?box=" \+ encodeURIComponent\(id\), \{ method: "POST" \}\)/);
  // by the steps every box beside the card takes (boxSink), the response piped
  // out beside a long reply's too, from beside its card if it was expanded
  assert.match(html, /function magicSink\(\)\{\s*magicSmall\(\);\s*boxSink\(MB, magicOff\);/);
  assert.match(html, /function boxSink\(box, off\)\{[\s\S]*?magicRise\(-1, off, box\);/);
  // and the agent's own close sinks it the same way, while anything else takes it off at once
  assert.match(html, /const shut = magicCard\(true\);\s*if \(shut && shut\.id === MB\.id\) magicSink\(\);\s*else magicOff\(\);/);
});

test("the box's edge line fades in and out on the rise with everything else on the box, and is plain once risen", () => {
  const html = read("index.html"), phone = read("m.html");
  // the box's own rules, with comments left out: its own and those it shares
  // with the response piped out beside a long reply (#pipebox)
  const rules = html.slice(0, html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "").match(/\n  (?::is\(#magicbox, #pipebox\)|#magicbox)[^{\n]*\{[^}]*\}/g);
  const rising = rules.find(r => /^\s*#magicbox\.rising\{/.test(r));
  const edge = rising.match(/border-color:color-mix\(in srgb, var\(--line\) calc\(var\(--rise\) \* 100%\), transparent\)/);
  assert.ok(edge, "the edge line does not follow --rise");
  // it is the same --rise the contents and the shadow follow, so the same time and curve
  assert.match(html, /\n  #magicbox\.rising > \*\{opacity:var\(--rise\)\}/);
  assert.match(rising, /\{--rise:0; transition:none;/, "the rise starts flat and the box does not ease on its own");
  // a share of 0% is no line and 100% the line's own colour, as the shadow's alpha is
  assert.match(rising, /box-shadow:0 calc\(3px \* var\(--rise\)\) calc\(14px \* var\(--rise\)\) rgba\(60,45,20,calc\(\.10 \* var\(--rise\)\)\),\s*0 calc\(1px \* var\(--rise\)\) calc\(2px \* var\(--rise\)\) rgba\(60,45,20,calc\(\.06 \* var\(--rise\)\)\)/);
  // nothing else colours the edge, and the shadow's own layers are untouched
  assert.ok(!/border-color/.test(rules.filter(r => r !== rising).join("")), "another rule recolours the edge");
  // the box held after the rise is the rule without the class, the line unscaled
  assert.match(html, /\n  :is\(#magicbox, #pipebox\)\{background:var\(--card\); border:var\(--edge\) solid var\(--line\);/);
  // the phone's box fades inside the drawer, edge included, and has no rise of its own
  assert.match(phone, /#tickets\{\s*\/\*[^*]*\*\/\s*opacity:var\(--list-v\);/);
  assert.ok(!/#mbface[^{]*\.rising|#mbface[^{]*\{[^}]*--rise/.test(phone), "the phone's box has a rise of its own");
});

test("the box rises out of the page as it first comes, its line with it, and faster once the owner is at it", () => {
  const html = read("index.html");
  assert.match(html, /const RISE_MS = 1000, RISE_FAST = 3;/);
  // what it holds follows the rise, and the line's strength too, shadow and all
  assert.match(html, /\n  #magicbox\.rising > \*\{opacity:var\(--rise\)\}/);
  assert.match(html, /function magicRiseSet\(t, box = MB\)\{[\s\S]*?box\.el\.style\.setProperty\("--rise", p\.toFixed\(4\)\);\s*box\.line\.style\.opacity = p\.toFixed\(4\);/);
  // a click, a key or a scroll in the box while it rises hurries the rest
  assert.match(html, /if \(MB\.el && MB\.rise\.dir > 0 && MB\.el\.contains\(e\.target\)\) MB\.rise\.fast = RISE_FAST;/);
  assert.match(html, /for \(const type of \["pointerdown", "keydown", "wheel"\]\) addEventListener\(type, magicHurry/);
  // only a box that opened on the card on screen since the last reading of the
  // board rises: coming back to its card, or a new revision, shows it risen
  assert.match(html, /const was = MB\.known;\s*if \(lastState\)\{\s*MB\.known = new Set\(lastState\.boxes\.filter\(x => x\.magic && x\.magic\.open\)\.map\(x => x\.id\)\);/);
  assert.match(html, /magicLoad\(b\.id, b\.magic\.rev, !!was && !was\.has\(b\.id\)\)/);
  assert.match(html, /const t = id === MB\.id && MB\.rise\.raf \? MB\.rise\.t : fresh \? 0 : 1;/);
  assert.match(html, /function magicOff\(keep\)\{[\s\S]*?magicRiseStop\(\);\s*magicRiseSet\(1\);/);
  // the lines lie beneath the card and the box: before the card on the page,
  // at the card's level, and under the box's; the card's own edge colour,
  // never the accent
  assert.ok(html.indexOf('<svg id="mbline"') < html.indexOf("<main>"));
  const rule = html.slice(0, html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "").match(/\n  body\.focus #mbline\.on\{[^}]*\}/)[0];
  assert.match(rule, /z-index:0/);
  assert.match(html, /body\.focus :is\(#magicbox, #pipebox\)\.on\{display:flex; position:fixed; z-index:1;/, "the box's own level, over the lines'");
  // it wears the card's own shadow, both layers, at the strength a filter gives
  // them (half the blur), and none when the card is lowered, as the box has none.
  // the shadow is on the group inside the svg and never on the svg, a layer of
  // its own whose filter is blurred again on every frame of a scroll (m1216)
  assert.ok(!/filter/.test(rule), "the svg's own layer wears the filter: " + rule);
  assert.match(html, /\n  body\.focus #mbline\.on > g\{filter:drop-shadow\(0 2px 9px rgba\(60,45,20,\.18\)\) drop-shadow\(0 1px 1\.5px rgba\(60,45,20,\.10\)\)\}/);
  assert.match(html, /\n  body\.lowered #mbline\.on > g\{filter:none\}/);
  assert.match(linesCode(), /MB\.line\.innerHTML = '<g>' \+ two\.ys\.map\([\s\S]*?\.join\(""\) \+ '<\/g>';/);
  assert.match(html, /\n  body\.focus:is\(\.home, \.editmode\) #mbline\.on\{display:none\}/);
  const lines = linesCode();
  assert.match(lines, /const ink = getComputedStyle\(document\.querySelector\("main"\)\)\.borderTopColor/);
  assert.ok(!/--accent|#432BFF|#D9D1BE/i.test(lines));
});

test("flipping to a card shows its box and lines in the same frame: what it holds is already on the page", () => {
  const html = read("index.html"), view = read("card-logic.js");
  // the switch draws from what the board holds, in the same task, with no
  // fetch, no wait and no rise; only a box never read yet is fetched
  const load = html.slice(html.indexOf("function magicLoad(id, rev, fresh){"), html.indexOf("function magicFetch("));
  assert.ok(!/async|await/.test(load), "the switch waits on something");
  assert.match(load, /const have = MB\.bodies\.get\(id\);\s*if \(have && have\.rev === rev && have\.box\)\{ magicDraw\(have\.box\); return; \}/);
  // every reading of the board fetches what every open box holds, whichever
  // card is on screen, once for each revision
  assert.match(html, /MB\.known = new Set\([^;]*\);\s*magicAhead\(\);/);
  assert.match(html, /if \(x\.magic\.open\) magicFetch\(x\.id, x\.magic\.rev\);/);
  assert.match(html, /function magicFetch\(id, rev\)\{\s*const have = MB\.bodies\.get\(id\);\s*if \(have && have\.rev === rev\) return have\.wait;/);
  // a picture fetched and read ahead, so the box takes its shape at once;
  // the view shows it at once when its size is known
  assert.match(html, /if \(box\.kind === "image" && box\.src\) magicPicture\(id \+ ":" \+ box\.rev, box\.src\);/);
  assert.match(html, /MB\.view\.draw\(box, box\.kind === "image" \? MB\.pictures\.get\(box\.box \+ ":" \+ box\.rev\) : null\);/);
  assert.match(view, /if \(seen && seen\.natural\)\{ view\.natural = seen\.natural; view\.known = true; return; \}/);
  assert.match(view, /return !!img && \(!view\.natural \|\| !img\.complete && !view\.known\);/);
  // a page's height said once is kept and taken at once the next time, and a
  // page never shown is measured ahead in a sealed frame of its own, unseen,
  // which runs as the shown one does and goes when it is done
  assert.match(html, /heard: \(height, width\) => \{ if \(MB\.id\) MB\.heights\.set\(MB\.id \+ ":" \+ MB\.rev, \{ w: width, h: height \}\); \}/);
  // (but not a height said while the box is expanded, at a width it never has beside its card)
  assert.match(view, /if \(tall > 0 && hooks\.heard && !view\.big\) hooks\.heard\(tall, run\.frame\.clientWidth\);/);
  const measure = html.slice(html.indexOf("function magicMeasure(){"), html.indexOf("function magicDraw("));
  assert.match(measure, /frame\.setAttribute\("sandbox", MagicBox\.PAGE_SANDBOX\);/);
  assert.match(measure, /frame\.srcdoc = MagicBox\.pageDoc\(have\.box\.html \|\| "", word, true\);/);
  assert.match(measure, /frame\.inert = true;/);
  assert.match(measure, /visibility: "hidden", pointerEvents: "none"/);
  assert.match(measure, /frame\.remove\(\);/);
  assert.match(measure, /if \(!MB\.el \|\| MB\.measuring\) return;/, "more than one page measured at a time");
  // the height is taken only at the width it was said at, within the pixel
  // and a half the box's edge rounds to
  const src = html.slice(html.indexOf("function magicHeight("), html.indexOf("\n}\n", html.indexOf("function magicHeight(")) + 3);
  const ctx = vm.createContext({ MB: { heights: new Map([["c:2", { w: 393.2, h: 145 }]]) } });
  vm.runInContext(src, ctx);
  assert.equal(ctx.magicHeight("c:2", 393), 145);
  assert.equal(ctx.magicHeight("c:2", 394.6), 145);
  assert.equal(ctx.magicHeight("c:2", 360), 0);
  assert.equal(ctx.magicHeight("c:3", 393), 0);
});

// the two lines and their dashes, run outside the page on stand-ins
const linesCode = () => {
  const html = read("index.html");
  return html.slice(html.indexOf("const TWO = {"), html.indexOf("if (MB.el){", html.indexOf("function magicLine(")));
};
// the card and the box as the connector mock has them (m1237,
// mock-box-connector-20261013.html), in stage pixels: the card at its saved
// place and size, the box's left edge at 1055.38 and its top at 89.86, 488 high
const PICK = { card: { left: 466.56, top: 51.84, width: 506.88, height: 760.32 }, box: { left: 1055.38, top: 89.86, width: 344.47, height: 488 } };
// the lines' levels are fixed distances in the box, so the stand-in needs no
// element to read: only the svg the lines are drawn into
const dashed = (scale = 1) => {
  const svg = () => { const s = { innerHTML: "", ons: 0, classList: { add() { s.ons++; } } }; return s; };
  const MB = { line: svg(), el: {} };
  const ctx = vm.createContext({ MB, stageScale: scale, getComputedStyle: () => ({ borderTopColor: "rgb(202, 202, 202)" }),
    document: { querySelector: () => ({}) } });
  vm.runInContext(linesCode(), ctx);
  return { ctx, MB };
};
// every path drawn: [start x, start y, end x, end y]
const PATH = /<path d="M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)" fill="none" stroke="rgb\(202, 202, 202\)" stroke-width="1\.3333333333333333" stroke-linecap="butt" stroke-dasharray="6 4"\/>/g;
const paths = svg => [...svg.innerHTML.matchAll(PATH)].map(m => m.slice(1, 5).map(Number));

test("the lines are the pick from the connector mock: on its box, 488 high, two dashed lines 52 px down from the top and 52 px up from the foot, from the card's edge to the box's and no further", () => {
  const { ctx, MB } = dashed();
  const near = (a, b, d = .01) => Math.abs(a - b) <= d;
  const { card, box } = PICK;
  const two = ctx.magicTwo(card, box);
  assert.equal(two.ys.length, 2);
  assert.ok(near(two.ys[0], box.top + 52, 1e-9) && near(two.ys[1], box.top + box.height - 52, 1e-9), [...two.ys].join());
  // each starts exactly at the card's right edge and stops at the box's left
  // edge: nothing of it is under either, which shows through whichever is faded
  assert.equal(two.from, card.left + card.width);
  assert.equal(two.to, box.left);
  ctx.magicLine(card, box);
  assert.equal(MB.line.ons, 1);
  // two horizontal paths, dashes 6 with gaps of 4, 4/3 wide (two thirds of the
  // 2 the mock drew), flat ends, in the
  // card's edge colour, and nothing else in the group
  const got = paths(MB.line);
  assert.equal(got.length, 2, MB.line.innerHTML);
  assert.match(MB.line.innerHTML, /^<g><path [^>]*\/><path [^>]*\/><\/g>$/);
  got.forEach(([x1, y1, x2, y2], i) => {
    assert.ok(near(y1, two.ys[i]) && near(y2, two.ys[i]), "a line is not level at its place: " + [y1, y2]);
    // each path starts at the box's edge, so its dashes are counted from it
    // and a whole dash ends exactly there
    assert.ok(near(x1, box.left) && near(x2, card.left + card.width), "a line runs elsewhere: " + [x1, x2]);
  });
  // the same box, the same lines, however often they are drawn
  const first = MB.line.innerHTML;
  ctx.magicLine(card, box);
  assert.equal(MB.line.innerHTML, first);
});

test("the lines sit 52/488 of the box's height from its top and its foot, so they look the same on a box of any size and never meet", () => {
  assert.equal(vm.runInContext("JSON.stringify(TWO)", dashed().ctx),
    JSON.stringify({ gap: 8, share: 52 / 488, width: 4 / 3, dash: 6, space: 4 }));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const { card, box } = PICK;
  const ys = (b, scale = 1) => [...dashed(scale).ctx.magicTwo(card, b).ys];
  // the rectangles are in the stage's own pixels: another scale reads the same
  assert.deepEqual(ys(box, .5), ys(box));
  assert.deepEqual(ys(box, 2), ys(box));
  // a share of the box, not a fixed distance: about 10.66% from each end,
  // mirrored, on a short box, a medium one and a tall one alike
  for (const height of [40, 90, 110, 200, 488, 600, 900]) {
    const [top, foot] = ys({ ...box, height });
    const n = height * 52 / 488;
    assert.ok(near(top - box.top, n) && near(box.top + height - foot, n), `a box ${height} high: ${[top, foot]}`);
    assert.ok(near((top - box.top) / height, 52 / 488), "the share moved with the height");
    // the two never meet: the gap between them is the rest of the box
    assert.ok(foot - top > height * .78, `a box ${height} high has its lines too close: ${foot - top}`);
  }
  // the short box of the report, about 110 high: about 11.7 px from each end,
  // 86.6 px apart, where the fixed 52 px had them 6 px apart
  const [top, foot] = ys({ ...box, height: 110 });
  assert.ok(Math.abs(top - box.top - 11.72) < .01 && Math.abs(foot - top - 86.56) < .01, [top, foot].join());
  // every box draws both lines, a short one too
  const { ctx, MB } = dashed();
  ctx.magicLine(card, { ...box, height: 90 });
  assert.equal(paths(MB.line).length, 2, MB.line.innerHTML);
  assert.ok(!/box\.height \/ 2|2 \* TWO/.test(linesCode()), "the one line at the middle is still there");
});

test("with no room for them no line is drawn: a gap narrower than 8 px", () => {
  const { ctx, MB } = dashed();
  const { card, box } = PICK;
  const edge = card.left + card.width;
  assert.equal(ctx.magicTwo(card, { ...box, left: edge }), null, "no gap");
  assert.equal(ctx.magicTwo(card, { ...box, left: edge + 7.9 }), null);
  assert.ok(ctx.magicTwo(card, { ...box, left: edge + 8 }));
  ctx.magicLine(card, { ...box, left: edge });
  assert.equal(MB.line.innerHTML, "", "a line was drawn with no gap");
  assert.equal(MB.line.ons, 0);
});

test("every box draws these same lines: nothing is picked, kept or read from the box, and the old layouts are gone", () => {
  const html = read("index.html"), server = read("server.py");
  const code = linesCode();
  assert.ok(!/Math\.random/.test(code), "the page picks the line itself");
  assert.ok(!/magic\.lines|lastState/.test(code), "the page reads a stored style");
  for (const gone of ["magicRoute", "magicLines", "magicChosen", "MAGIC_NEAR", "mblines", "mbtabs"])
    assert.ok(!html.includes(gone), gone + " is still in the page");
  assert.ok(!/\.2205|\.0601|\.436|\.0413|\.887|\.0959/.test(code), "an old layout's numbers are in the line's code");
  for (const gone of ["MAGIC_LINES", "_magic_lines", "magic_lines_last"])
    assert.ok(!server.includes(gone), gone + " is still in the server");
  // what a box record keeps is no longer a style
  assert.match(server, /box\["magic"\] = \{"open": True, "kind": kind, "rev": rev, "ts": now\}/);
});

test("the lines are plain dashes: no barbell, tabs, dots, brush, dabs or beads", () => {
  const html = read("index.html");
  for (const gone of ["magicDrone", "DRONE", "Drone", "magicOne", "const ONE = {", "cardTab:", "boxTab:", "rimInk", "barbell"])
    assert.ok(!html.includes(gone), gone + " is still in the page");
  assert.ok(!/\.083\b/.test(linesCode()), "the barbell's 8.3% is in the lines' code");
  const { ctx, MB } = dashed();
  ctx.magicLine(PICK.card, PICK.box);
  // two straight paths of two points each, nothing else
  const parts = MB.line.innerHTML.match(/<(path|rect|circle|ellipse)\b/g);
  assert.deepEqual(parts, ["<path", "<path"], MB.line.innerHTML);
  for (const [, d] of MB.line.innerHTML.matchAll(/<path d="([^"]*)"/g))
    assert.ok(!/[aAcCqQ]/.test(d), "a line's path is not straight: " + d);
  assert.ok(!/stroke-linecap="round"|stroke-dasharray="0 /.test(MB.line.innerHTML), "the lines are dotted");
});

test("a site that will not be framed comes square, with its name and a new-page mark in a box in the middle", () => {
  const view = read("card-logic.js");
  const nameFn = view.slice(view.indexOf("function magicSiteName("), view.indexOf("function magicView("));
  const ctx = vm.createContext({ URL });
  vm.runInContext(nameFn, ctx);
  assert.equal(ctx.magicSiteName({ url: "https://www.google.com/", preview: { site: "www.google.com" } }), "google.com");
  assert.equal(ctx.magicSiteName({ url: "https://github.com/x", preview: { site: "GitHub" } }), "GitHub");
  assert.equal(ctx.magicSiteName({ url: "https://www.example.org/" }), "example.org");
  const draw = view.slice(view.indexOf("view.draw = (box, seen) => {"), view.indexOf("const page = (html, tries) => {"));
  assert.ok(draw.length > 500);
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
  // the two looks, one value each for the card and the box: the one worked in wears
  // exactly the shadow a card with no box wears (the heavier one is gone), and the
  // other the faintest soft shadow, a small spread over a hairline, there on the
  // paper but far below it in blur and strength in each layer, at 60%
  assert.ok(!/shade-deeper/.test(html), "the heavier shadow is still in the page");
  const vars = html.match(/\n  body\.focus\{--shade-raised:([^;]*);\s*--shade-lighter:([^;]*);\s*--shade-unselected:([^}]*)\}/);
  const raised = vars[1], lighter = vars[2], fade = vars[3];
  const layers = s => [...s.matchAll(/(\d+)px (\d+)px rgba\(60,45,20,([.\d]+)\)/g)].map(m => [+m[1], +m[2], +m[3]]);
  const raisedLayers = layers(raised), lighterLayers = layers(lighter);
  assert.deepEqual(raisedLayers, [[2, 18, .18], [1, 3, .10]], "the card with no box keeps the plain raised shadow");
  assert.equal(raised, "0 2px 18px rgba(60,45,20,.18), 0 1px 3px rgba(60,45,20,.10)", "the shadow it has always worn");
  assert.equal(lighterLayers.length, 2, "a small soft spread and a hairline");
  const [soft, hair] = lighterLayers;
  assert.ok(soft[1] >= 8 && soft[1] <= 16 && soft[2] >= .06 && soft[2] <= .12, "the soft layer is a small, faint spread that is there");
  assert.ok(hair[1] <= 3 && hair[2] > 0 && hair[2] <= .08, "the hairline under it is tight and faint");
  lighterLayers.forEach(([dy, blur, alpha], i) => {
    assert.ok(dy >= raisedLayers[i][0] && blur <= raisedLayers[i][1] && alpha <= raisedLayers[i][2], `layer ${i} of the lighter shadow is above the raised one`);
  });
  assert.ok(!/rgba?\((?!60,45,20)|#[0-9a-f]/i.test(raised + lighter), "no colour but the card's shadow brown");
  assert.equal(fade, ".6", "the one not selected is shown at 60%");
  // the card with no box is untouched: its own rule wears the raised shadow, whole, and no
  // opacity
  const card = html.slice(html.indexOf("  body.focus main{"), html.indexOf("}", html.indexOf("  body.focus main{")));
  assert.match(card, /box-shadow:var\(--shade-raised\);/, "the card's own raised shadow");
  assert.ok(!/(^|[;\s])opacity:/.test(card), "a card with no box fades");
  // the card steps back to the faint shadow and the fade while its box is held and
  // stands beside it: at the settled rule's own weight, ahead of the lowered card's
  // rule, so a lowered card stays level. the box being on and held is a mark on the
  // body (body.mbheld) and so is its standing beside the card (body.mbon), and not a
  // :has() there, which restyled the whole page whenever any element's "on" or
  // "held" changed, the caret's on every frame of a scroll
  const rule = "  body.focus:not(.home, .editmode):where(.mbon.mbheld) main{box-shadow:var(--shade-lighter); opacity:var(--shade-unselected)}";
  assert.ok(html.includes(rule));
  assert.ok(!html.includes(":where(.mbon) main"), "the card has a look of its own while the box stands beside it");
  assert.ok(html.indexOf(rule) < html.indexOf("  body.focus.lowered main{box-shadow:none}"));
  assert.ok(html.indexOf("  body.focus.minifocus main{") < html.indexOf(rule), "after the settled rule, which it weighs the same as");
  assert.match(html, /\n  body\.focus\.lowered main\{box-shadow:none\}/, "the lowered card keeps today's rule: no shadow, and no say over the fade");
  // each :has() and the compound it hangs off, read back over any brackets
  const sheet = code(html.slice(0, html.indexOf("</style>")));
  const anchors = [...sheet.matchAll(/:has\(/g)].map(m => {
    let i = m.index, depth = 0;
    for (; i > 0; i--){
      const ch = sheet[i - 1];
      if (ch === ")") depth++;
      else if (ch === "(") depth--;
      else if (!depth && /[\s{},>+~]/.test(ch)) break;
    }
    return sheet.slice(i, m.index);
  });
  assert.ok(anchors.length > 0);
  assert.deepEqual(anchors.filter(a => /^body\b/.test(a)), [], "a :has() on the body");
  // both ease over the card's own timing, and the shadow is all they change
  assert.match(card, /transition:box-shadow \.2s, opacity \.2s;/);
  // the box's rules are the response's piped out beside a long reply too (#pipebox)
  assert.match(html, /\n  :is\(#magicbox, #pipebox\)\{background:var\(--card\); border:var\(--edge\) solid var\(--line\); border-radius:var\(--mb-round\);\s*box-shadow:var\(--shade-lighter\); opacity:var\(--shade-unselected\); transition:box-shadow \.2s, opacity \.2s\}/);
  const style = html.slice(0, html.indexOf("</style>"));
  const rules = [...style.matchAll(/\n  ([^\n{]*\.held[^\n{]*)\{([^}]*)\}/g)];
  assert.deepEqual(rules.map(r => r[1].trim()), [":is(#magicbox, #pipebox).held", "#magicbox.rising.held", "#pipebox.held"],
    "the box's, the box's as it rises, and the shadow of the response piped out beside a long reply");
  assert.equal(rules[0][2].trim(), "box-shadow:var(--shade-raised); opacity:1", "the box held is whole");
  assert.match(rules[1][2].trim(), /^box-shadow:[^;]*$/);
  assert.match(rule.slice(rule.indexOf("{") + 1, -1), /^box-shadow:var\(--shade-lighter\); opacity:var\(--shade-unselected\)$/);
  // the mark follows the box's own classes, whatever changes them: on only
  // while the box is both on and held
  const mirror = html.match(/\nif \(MB\.el\) new MutationObserver\([\s\S]*?\);\n/)[0];
  const boxClasses = new Set(), bodyClasses = new Set();
  let seen = null, watched = null;
  const toggle = set => (c, yes) => (yes ? set.add(c) : set.delete(c));
  vm.runInContext(mirror, vm.createContext({
    MB: { el: { classList: { contains: c => boxClasses.has(c) } } },
    document: { body: { classList: { toggle: toggle(bodyClasses) } } },
    MutationObserver: class { constructor(fn){ seen = fn; } observe(el, opts){ watched = opts; } },
  }));
  assert.equal(JSON.stringify(watched), JSON.stringify({ attributeFilter: ["class"] }), "the box's class and nothing else");
  const mark = (...on) => { boxClasses.clear(); on.forEach(c => boxClasses.add(c)); seen(); return bodyClasses.has("mbheld"); };
  assert.equal(mark("on", "held"), true, "on and held");
  assert.equal(mark("on"), false, "on, not held");
  assert.equal(mark("held"), false, "held while off the page, as a new revision loads");
  assert.equal(mark("on", "held", "rising"), true, "held as it rises");
  assert.equal(mark(), false, "taken off");
  // the box stands in the page on the card's own shadow when held and the faint one,
  // faded, when not
  assert.match(html, /\n  :is\(#magicbox, #pipebox\)\.held\{box-shadow:var\(--shade-raised\); opacity:1\}/);
  // risen, the rising ones are the held one and the settled one exactly
  const unrise = s => s.replace(/calc\(([^)]*?) \* var\(--rise\)\)/g, "$1").replace(/\s+/g, " ").trim();
  assert.equal(unrise(html.match(/\n  #magicbox\.rising\.held\{\s*box-shadow:([^}]*)\}/)[1]), raised);
  assert.equal(unrise(html.match(/\n  #magicbox\.rising\{[^}]*?box-shadow:([^}]*)\}/)[1]), lighter);
  // the lowered box has no shadow, and no rule of the lowered card or box touches the fade
  assert.match(html, /\n  body\.lowered :is\(#magicbox, #pipebox\)\.on\{box-shadow:none\}/);
  assert.ok(!/body\.lowered[^{\n]*\{[^}]*opacity/.test(html.slice(0, html.indexOf("</style>"))), "a lowered rule changes the fade");
  // the mark of a box beside the card: on, and not hidden for want of room, read off
  // the box's class and style whatever changes them
  const beside = html.match(/\nif \(MB\.el\) new MutationObserver\(\(\) => document\.body\.classList\.toggle\("mbon"[\s\S]*?\);\n/)[0];
  const boxStyle = { visibility: "" };
  let seenBeside = null, watchedBeside = null;
  vm.runInContext(beside, vm.createContext({
    MB: { el: { classList: { contains: c => boxClasses.has(c) }, style: boxStyle } },
    document: { body: { classList: { toggle: toggle(bodyClasses) } } },
    MutationObserver: class { constructor(fn){ seenBeside = fn; } observe(el, opts){ watchedBeside = opts; } },
  }));
  assert.equal(JSON.stringify(watchedBeside), JSON.stringify({ attributeFilter: ["class", "style"] }), "the box's class and style and nothing else");
  const stands = (hidden, ...on) => { boxClasses.clear(); on.forEach(c => boxClasses.add(c)); boxStyle.visibility = hidden ? "hidden" : ""; seenBeside(); return bodyClasses.has("mbon"); };
  assert.equal(stands(false, "on"), true, "on and shown");
  assert.equal(stands(false, "on", "held"), true, "on, shown and held");
  assert.equal(stands(true, "on"), false, "open but hidden for want of room: the card is as if it had none");
  assert.equal(stands(false), false, "off the page");
  // the box goes off the page settled, and put back first if it was expanded;
  // the agent's next revision keeps it held, and expanded
  assert.match(html, /function magicOff\(keep\)\{\s*if \(!MB\.el\) return;\s*if \(!keep\) magicSmall\(\);\s*MB\.el\.classList\.remove\("on", "held", "over", "rising"\);/);
  // and risen, unless it was still rising or sinking, or is new on the card
  assert.match(html, /const held = id === MB\.id && MB\.el\.classList\.contains\("held"\);\s*const t = id === MB\.id && MB\.rise\.raf \? MB\.rise\.t : fresh \? 0 : 1;\s*magicOff\(id === MB\.id\);\s*MB\.el\.classList\.toggle\("held", held\);\s*boxCome\(MB, t\);/);
  assert.match(html, /function boxCome\(box, t\)\{\s*magicRiseSet\(t, box\);\s*box\.el\.classList\.toggle\("rising", t < 1\);/);
});

// a selector's weight, for the plain ones these rules use: ids, then classes,
// then elements. an :is() of ids alone weighs as one of them
const weight = sel => {
  const selector = sel.replace(/:is\((#[\w-]+)(?:, #[\w-]+)*\)/g, "$1");
  return [(selector.match(/#[\w-]+/g) || []).length, (selector.match(/\.[\w-]+/g) || []).length,
    (selector.replace(/[#.][\w-]+/g, "").match(/[a-z][\w-]*/g) || []).length];
};
const heavier = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

test("the Mac's box has the card's face, edge and shadow; the phone's has no box; a lowered card's box sits level, held or not", () => {
  const html = read("index.html"), phone = read("m.html"), style = code(html.slice(0, html.indexOf("</style>")));
  // the board's box: the card's white, edge line and shadow, with corners twice the card's 7px
  // its rules, shared with the response piped out beside a long reply (#pipebox)
  const face = style.match(/\n  :is\(#magicbox, #pipebox\)\{background:var\(--card\); [^}]*\}/)[0];
  const card = html.slice(html.indexOf("  body.focus main{"), html.indexOf("}", html.indexOf("  body.focus main{")));
  assert.match(card, /border:var\(--edge\) solid var\(--line\); background:#fff; border-radius:7px;/);
  assert.match(face, /border:var\(--edge\) solid var\(--line\); border-radius:var\(--mb-round\);/, "the card's own edge");
  assert.equal(read("card-tokens.css").match(/\.magicbox\{[^}]*--mb-round:(\d+)px;/)[1], "14", "twice the card's 7px");
  assert.ok(!/outline/.test(face));
  // and that is the only edge any of the board's box rules draws, its colour
  // alone scaled by the rise while the box comes and goes
  const borders = style.match(/\n  (?::is\(#magicbox, #pipebox\)|#magicbox)[^{]*\{[^}]*\}/g).join("").match(/border(?!-radius)[\w-]*:[^;}]*/g);
  assert.deepEqual(borders, ["border:var(--edge) solid var(--line)",
    "border-color:color-mix(in srgb, var(--line) calc(var(--rise) * 100%), transparent)"]);
  // the bar is the card's white with no line under it, the cross's seat its white
  assert.match(style, /\n  #magicbox \.mbbar\{background:var\(--card\)\}/);
  assert.match(style, /\n  #magicbox \.mbbar::after\{display:none\}/);
  assert.ok(!/#magicbox \.mbclose/.test(style), "the board leaves the cross's red circle to the sheet");
  // its words keep the card answer's inset off the sides, and --mb-lead under the bar
  assert.match(style, /\n  #magicbox \.mbtext\{padding:var\(--mb-lead\) var\(--mb-inset, 16px\) var\(--mb-inset, 16px\)\}/);
  // the lowered card's rule outweighs every rule that shades the box, held or not
  const level = style.match(/\n  (body\.lowered :is\(#magicbox, #pipebox\)\.on)\{box-shadow:none\}/);
  assert.ok(level, "no rule for a box beside a lowered card");
  const shading = [...style.matchAll(/\n  ((?:body\.lowered )?(?::is\(#magicbox, #pipebox\)|#magicbox)[^\n{ ]*)\{[^}]*box-shadow:[^}]*\}/g)].map(m => m[1]).filter(s => s !== level[1]);
  // the two, and the same two scaled by the rise as it comes and goes
  const both = ":is(#magicbox, #pipebox)";
  assert.deepEqual(shading, [both, both + ".held", "#magicbox.rising", "#magicbox.rising.held"], "the box's shadows");
  for (const s of shading) assert.ok(heavier(weight(level[1]), weight(s)) > 0, level[1] + " does not outweigh " + s);
  assert.ok(html.includes("  body.focus.lowered main{box-shadow:none}"));
  // the shared sheet dresses no box: each page does its own
  const sheet = code(boxBlock());
  assert.ok(!/box-shadow|\.held/.test(sheet), "the shared sheet shades the box");
  assert.ok(!/\.magicbox\{[^}]*(background|border)/.test(sheet.replace(/\s+/g, " ")), "the shared sheet dresses the box");
  // the phone gives the same corners in its own units: twice the card's calc(7 * var(--u))
  assert.match(phone, /#mbface\{display:none;[^}]*--mb-round:calc\(14 \* var\(--u\)\)/);
  assert.match(phone, /\n  main\{[^}]*border-radius:calc\(7 \* var\(--u\)\)/);
  // the phone's box is dressed as the board's: the card's white face, edge line and
  // corners (in the phone's units, as its card is), and the faint shadow the board's
  // box wears while its card is the one worked in (--shade-lighter), which on the
  // phone, where the box is only read, is always
  const sty = code(phone.slice(0, phone.indexOf("</style>")));
  const dress = sty.match(/\n  #mbface\{background:var\(--card\); ([^}]*)\}/);
  assert.ok(dress, "the phone's box has no face");
  assert.match(dress[1], /^border:var\(--edge\) solid var\(--line\); border-radius:var\(--mb-round\);\s*box-shadow:0 3px 14px rgba\(60,45,20,\.10\), 0 1px 2px rgba\(60,45,20,\.06\)$/);
  const faint = style.match(/--shade-lighter:([^;}]*)/)[1].trim();
  assert.equal(dress[1].match(/box-shadow:([^;}]*)$/)[1].trim(), faint, "the phone's box does not wear the board's faint shadow");
  assert.ok(!/shade-deeper|mbon|mbheld/.test(phone), "the phone raises the card or the box");
  assert.ok(!/outline/.test(dress[1]));
  // the only edge any phone rule draws on the box, and the white bar without its line
  const subjects = selectors => selectors.split(",").map(s => s.trim().split(/\s+/).pop());
  const own = [...sty.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(m => /box-shadow|border|background/.test(m[2]) && /^\s*(body\.lowered )?#mbface\s*$/.test(m[1]));
  assert.deepEqual(own.map(m => m[1].trim()), ["#mbface", "body.lowered #mbface"], "the phone dresses its box in these two rules");
  assert.ok((own[0][2].match(/border(?!-radius)[\w-]*:/g) || []).length === 1, "one edge");
  assert.match(sty, /\n  #mbface \.mbbar::after\{display:none\}/, "no line under the bar");
  // its words keep the card answer's inset off its sides, as the board's do. its bar
  // is at its foot, so the box is the board's turned over and its words are not: the
  // far edge's white (the air and the inset) is over them, the lead under them, and
  // the bar and the body each keep inside the round corners on their own side
  assert.match(sty, /\n  #mbface \.mbtext\{padding:var\(--mb-inset\) var\(--mb-inset\) var\(--mb-lead\)\}/);
  assert.match(sty, /\n  #mbface \.mbbody\{margin:var\(--mb-air\) 0 0; border-radius:calc\(var\(--mb-round\) - var\(--edge\)\) calc\(var\(--mb-round\) - var\(--edge\)\) 0 0\}/);
  assert.match(sty, /\n  #mbface \.mbbody:is\(\[data-kind="image"\], \.alone\)\{margin:0\}/, "a picture still fills its box to the edge, and one from the words shown alone");
  assert.match(sty, /\n  #mbface \.mbbar\{border-radius:0 0 calc\(var\(--mb-round\) - var\(--edge\)\) calc\(var\(--mb-round\) - var\(--edge\)\)\}/);
  // a lowered card's box sits level on the phone too, and outweighs the shadow it takes off
  assert.match(sty, /\n  body\.lowered #mbface\{box-shadow:none\}/);
  assert.ok(heavier(weight("body.lowered #mbface"), weight("#mbface")) > 0);
  assert.ok(sty.includes("  body.lowered main{box-shadow:none}"));
  // no line is drawn between the card and the box on the phone
  assert.ok(!/mbline/.test(phone), "the phone draws a line between its card and its box");
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
  assert.match(view, /frame\.srcdoc = MagicBox\.pageDoc\(html, run\.word, !!hooks\.sized, !!hooks\.tall\)/);
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
// out, shut and the run it goes back on are the stand-ins'. card "a"'s box is
// already drawn, as the page has it once it has read it, unless drawn is false.
// draws: what the view was asked to draw, [box, seen]
// the time and curve a card's picture zooms on, and its turn on the way back
// (card-logic.js), which both pages' boxes zoom on too
function pictureTime() {
  const logic = read("card-logic.js"), turn = logic.indexOf("function cardPictureTurn(");
  const ctx = vm.createContext({});
  vm.runInContext(logic.slice(logic.indexOf("const CARD_PICTURE_MS"), logic.indexOf("const CARD_PICTURE_VEIL")) +
    logic.slice(turn, logic.indexOf("\n}\n", turn) + 3) + ";this.out = { CARD_PICTURE_MS, CARD_PICTURE_EASE, cardPictureTurn };", ctx);
  return ctx.out;
}
function phoneBoxScript(page, { drawn = true } = {}) {
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
    getBoundingClientRect: () => ({ top: 0, bottom: 89, height: 89 }), on: {},
    addEventListener(type, fn) { (box.on[type] = box.on[type] || []).push(fn); } };
  const words = { getBoundingClientRect: () => ({ bottom: 81 }), style: { paddingBottom: "16px" } };
  const body = { scrollHeight: 60, clientHeight: 60, querySelector: () => words, getBoundingClientRect: () => ({ bottom: 81 }) };
  const parts = { mbface: box, tikhead: { animate: animate("list names"), style: {} },
    tiklist: { animate: animate("list rows"), style: { marginBottom: "-7px" }, getBoundingClientRect: () => ({ bottom: parts.listEnd }) },
    listEnd: 1e9 };
  const face = () => (classes.has("boxface") ? "box" : "list") + " from the " + tickets.dataset.side;
  const paneClasses = new Set(), paneListeners = {}, draws = [];
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
    // 90px under the box), the drawer's lift (10px with the list, 4px with the
    // box, both written by the page's fitList) and a stop that cancels what is playing
    LIST_KEYED: true, LIST_CALM: { matches: false }, LIST_FADE_TOP: .999, LIST_SETUP_MS: 200,
    listSpring: (from, to) => ({ ms: 100, at: t => from + (to - from) * Math.min(1, t / 100), velocity: () => 0 }),
    menuTravel: () => 300, menuSign: p => p.dataset.side === "right" ? -1 : 1,
    listDrop: 120, listLift: 10, listRoom: 400, listPlay: [], listRun: null, ticketDrawerRun: 0, performance: { now: () => 0 },
    stopList: () => { classes.delete("swapface"); for (const a of ctx.listPlay) a.cancel(); ctx.listPlay = []; },
    settleTicketDrawer: () => calls.push("settled"), renderTickets() {},
    lastState: { boxes: [{ id: "a", owner: "p", done: false, magic: { open: true, rev: 1 } }, { id: "b", owner: "p", done: false }] },
    magicView: () => ({ body, want: () => ({ height: 89 }), waiting: () => false,
      draw: (box, seen) => draws.push([box, seen]), clear() {}, solo() {} }),
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
    listMoving: () => drawer.runs.length > 0, runMenu() {},
    fitList: now => { if (now){ ctx.listDrop = classes.has("boxface") ? 90 : 120; ctx.listLift = classes.has("boxface") ? 4 : 10; } }, poll() {},
    fetch: url => { calls.push(url); return new Promise(() => {}); },
    apply: () => calls.push("apply"), select: () => calls.push("select"), deselect: () => calls.push("deselect"),
    openDrawer: () => calls.push("list"), listSlack: () => ctx.spareRoom ?? 7, drawerPane: () => null,
    // the page's building of the cards near the one on show: here the card on
    // show alone, unless a test says which
    reachCards() {}, pullGoing: () => false,
    nearbyCards: () => ({ build: new Set([ctx.shownId]), keep: new Set([ctx.shownId]) }),
    phoneShortcutActions: {}, menuShortcutActions: {}, ...pictureTime(),
    addEventListener: (type, fn, opts) => { (listeners[type] = listeners[type] || []).push({ fn, opts }); },
  };
  const context = vm.createContext(ctx);
  vm.runInContext(src, context);
  if (drawn) vm.runInContext(`PB.id = "a"; PB.rev = 1; PB.drawn = true;`, context);
  const PB = vm.runInContext("PB", context);
  return { ctx, classes, tickets, listeners, calls, drawer, anims, paneClasses, paneListeners, body, pageEl, notch, box, parts, draws, PB };
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
  // the card goes down only as far as the box needs, and stands .88 of A under its
  // bottom edge (89), as it does under the list's foot. here, with nothing
  // drawn and the notch at 0: the list's first mark (14.9 under the drawer's top)
  // is A = 14.9 under it, and the box, whose own first mark is its top edge, is
  // moved down 14.9 to the list's. what the drawer spares under that is the room
  // (400) less the card's drop
  const under = foot => 400 - (foot + .88 * 14.9 + (14.9 - 0));
  assert.ok(Math.abs(ctx.listSlack() - under(89)) < 1e-9, "the card goes down only as far as the box's bottom edge needs");
  // words that run on scroll in a window inside the box change nothing: the
  // card stands as far under the box's edge as under the list
  body.scrollHeight = 600;
  assert.ok(Math.abs(ctx.listSlack() - under(89)) < 1e-9, "the card stands under the box's edge, not the window the words scroll in");
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
  assert.ok(calls.includes("apply") && !calls.some(c => String(c).startsWith("/magic/body")),
    "every reading is the page's own, and a box drawn at its revision is not read again");
  // a page that has not read the box yet reads it for the card on screen
  const fresh = phoneBoxScript(page, { drawn: false });
  fresh.ctx.apply({});
  assert.ok(fresh.calls.some(c => String(c).startsWith("/magic/body?box=a")), "the card on screen's box was not read");
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
  // more than 2% of the way to go is the 99th). the drawer stands at the box's
  // lift (4) from the first frame, so the box comes in at the height it rests
  // at, and the list going is let down by as much as the drawer went up from
  // the list's (10), 6px, so it leaves from where it stood
  for (const name of ["list names", "list rows"]) {
    const going = part(name);
    assert.deepEqual(ends(going, "transform"), ["translate3d(0px, -6px, 0px)", "translate3d(-297px, -6px, 0px)"], name);
    assert.deepEqual(ends(going, "opacity"), [.999, .01], name);
    assert.deepEqual([going.opts.duration, going.opts.delay || 0, going.opts.fill], [99, 0, "both"], name);
  }
  let coming = part("box");
  assert.deepEqual(ends(coming, "transform"), ["translate3d(300px, 0px, 0px)", "translate3d(0px, 0px, 0px)"]);
  assert.deepEqual(ends(coming, "opacity"), [0, .999]);
  assert.deepEqual([coming.opts.delay || 0, coming.opts.fill], [0, "backwards"], "the box waited for the list to go");
  assert.deepEqual(ends(part("drawer"), "transform"), ["translate3d(0px, -124px, 0px)", "translate3d(0px, -94px, 0px)"],
    "the drawer carries the box's lift from the first frame to the last");
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
  assert.deepEqual(ends(part("box"), "transform"), ["translate3d(0px, 6px, 0px)", "translate3d(297px, 6px, 0px)"]);
  coming = part("list rows");
  assert.deepEqual(ends(coming, "transform"), ["translate3d(-300px, 0px, 0px)", "translate3d(0px, 0px, 0px)"]);
  assert.equal(coming.opts.delay || 0, 0, "the list waited for the box to go");
  assert.deepEqual(ends(part("drawer"), "transform"), ["translate3d(0px, -100px, 0px)", "translate3d(0px, -130px, 0px)"]);
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
  // the skill stays at the top of the repository, above app/
  const cli = read("facilitator"), runbook = read("RUNBOOK.md"), skill = read("../.agents/skills/facilitator/SKILL.md");
  assert.match(cli, /\n    elif cmd == "magic":\n        cmd_magic\(args\)\n/);
  assert.ok(!/cmd == "sidenote"/.test(cli), "the side note command is still taken");
  for (const [name, text] of [["facilitator", cli], ["RUNBOOK.md", runbook], ["SKILL.md", skill]]) {
    assert.ok(!/side[ -]?note/i.test(text), name + " still names a side note");
    assert.match(text, /facilitator magic CARD|facilitator magic m12/, name);
  }
  assert.match(runbook, /\n## The magic box\n/);
  assert.match(read("../docs/board.md"), /\n## Seeing a card's magic box\n/);
  assert.match(skill, /the runbook's "The magic box" section/);
  // what the board says back to an agent, in the same name
  const server = read("server.py");
  assert.ok(!/side[ -]?note/i.test(server), "the server still says side note");
  for (const words of ["this card has no magic box", "the box would be empty", "the box could not be written",
    "a website box takes one web address on one line", "this card's box holds no picture"])
    assert.ok(server.includes(`"${words}"`), words);
  // the routes and the stored folder keep their names
  assert.match(server, /Route\("\/magic", _endpoint\(_post_magic/);
  assert.match(server, /MAGIC_DIR = DATA \/ "magic-boxes"/);
});

// a section of the list as the box script reads it, laid out from the drawer's top (no padding of
// its own here): its tickets end `end` under that top, and one longer than its window, which ends
// at `window`, scrolls. the script reads the section, never a row, which may be drawn lifted
const section = (end, window = Infinity) => ({ children: [{ offsetParent: {} }], style: {},
  scrollHeight: end, clientHeight: Math.min(end, window), scrollTop: 0,
  getBoundingClientRect: () => ({ top: 0, bottom: Math.min(end, window) }) });

test("both faces start at one height, with one gap above and below: the list is lifted by half its difference, the box follows", () => {
  const { ctx, tickets, pageEl, notch, box } = phoneBoxScript(read("m.html"));
  // the lift as the page's fitList writes it, read from the box script that says how far
  const lift = () => { ctx.fitList(true); return ctx.listLiftAt().toFixed(2) + "px"; };
  // the page's top 0 and padding 40, the room 400, the drawer's top at 50, the notch's foot at 30;
  // the list's last ticket ends 360 under the drawer's top with 7 spare under it, so the card
  // stands at 40 + 400 - 7 = 433. the list's first mark (14.9 under its top) is 34.9 under the
  // notch and its foot 23 above the card: it goes up 5.95 and both gaps are A = 28.95
  pageEl.style.paddingTop = "40px"; tickets.style.top = "50px"; notch.getBoundingClientRect = () => ({ height: 30 });
  let ticketsEnd = 360;
  ctx.drawerPane = () => section(ticketsEnd);
  assert.equal(lift(), "5.95px");
  ticketsEnd = 100;
  assert.equal(lift(), "0.00px", "a list already nearer the notch than the card is not lowered");
  ticketsEnd = 360;
  // the box takes the list's place: its top edge (the first mark it draws, 0 under its top) at
  // the list's mark, so it is 14.9 lower in its own terms, 5.95 - 14.9 of lift. its bottom edge
  // is 89 under its top (its drawn foot, the white under its words included) and the card
  // stands .88 of A = 28.95 under that: a drop of 50 + 8.95 + 89 + .88 * 28.95 - 40, the spare
  // 400 less that
  const below = .88 * 28.95;
  ctx.drawerFace(true);
  assert.equal(lift(), "-8.95px");
  const marks = { list: 50 + 14.9 - 5.95, box: 50 + 0 + 8.95 };
  assert.ok(Math.abs(marks.list - marks.box) < 1e-9, "one top for both faces");
  assert.ok(Math.abs(ctx.listSlack() - (400 - (50 + 8.95 + 89 + below - 40))) < 1e-9, "the card stands .88 of A under the box's bottom edge");
  // whatever the words do inside it, the foot is the box's: a scrolling body changes nothing
  box.offsetHeight = 300;
  assert.ok(Math.abs(ctx.listSlack() - (400 - (50 + 8.95 + 300 + below - 40))) < 1e-9, "the box's own foot, not its words'");
  // a box tall enough to need the card further down than the room allows stops it there
  // (the box is never fitted so tall: see the next test)
  box.offsetHeight = 433;
  assert.equal(ctx.listSlack(), 0, "the card goes down no further than the room, as before");
  const page = read("m.html");
  // both sides' transforms carry the lift whole, however far out the drawer is, so it comes in
  // at the height it rests at and never rises or sinks as it comes or goes
  assert.equal((page.match(/calc\(-1 \* \(var\(--list-v\) \* var\(--list-drop, 0px\) \+ var\(--tik-lift, 0px\)\)\)/g) || []).length, 2,
    "both sides' transforms carry the whole lift");
  assert.ok(!/var\(--list-v\) \* \(var\(--list-drop, 0px\) \+ var\(--tik-lift, 0px\)\)/.test(page), "a transform scales the lift with the drawer");
  assert.match(page, /padding-top:max\(0px, calc\(env\(safe-area-inset-top, 0px\) - \$\{NOTCH_GAP\}px\)\)/, "the notch's foot is read from the safe area");
});

test("the drawer's lift is worked out before any run and every run carries it, so a drawer never moves once it has landed", () => {
  const page = read("m.html");
  const fit = page.slice(page.indexOf("function fitList(now){"), page.indexOf("fitList(true);", page.indexOf("function fitList(now){")));
  // with the drop, before the run is planned, and a refit glides it as it glides the drop
  assert.match(fit, /const lifted = listLift;\s*liftList\(listLiftAt\(\)\);\s*const drop = room - listSlack\(\)/);
  assert.match(fit, /fit: \[was, drop\], lift: \[lifted, listLift\]/);
  // the run out or back, and a refit, as keyframes: the drawer's transform is the stylesheet's,
  // the lift included, so where the keyframes end is where the sheet takes over
  const play = page.slice(page.indexOf("function playList(){"), page.indexOf("function paintMenu("));
  assert.match(play, /const place = run\.fit \? at => \[1, from \+ \(to - from\) \* at, up \+ \(upTo - up\) \* at\] : v => \[v, from, listLift\];/);
  assert.match(play, /play\(tickets, \(v, drop, lift\) => \(\{ transform: `translate3d\(\$\{px\(\(v - 1\) \* travel\)\}, \$\{px\(-\(v \* drop \+ lift\)\)\}, 0px\)`/);
  // the faces' swap: the drawer at the new face's lift from the first frame, the face going let
  // down by the lift's change (see the keys' test for the numbers)
  const swap = page.slice(page.indexOf("function drawerSwapFace("), page.indexOf("function drawerSwapFirstFrame("));
  assert.match(swap, /const lifted = listLift;\s*showFace\(\);/);
  assert.match(swap, /play\(tickets, frames\(ms, t => \(\{ transform: `translate3d\(0px, \$\{px3\(-\(drop\(t\) \+ listLift\)\)\}, 0px\)` \}\)\), ms, "backwards"\)/);
  assert.match(swap, /goingParts\.map\(el => play\(el, frames\(cut, t => face\(shut\.at\(t\), away, listLift - lifted\)\), cut, "both"\)\)/);
  // the box script says how far and no longer writes the lift after the drop
  assert.match(page, /listLiftAt = \(\) => place\(\)\.lift;/);
  assert.ok(!/setProperty\("--tik-lift", at\.lift/.test(page), "the lift is written after the drop again");
});

test("a full list is lifted as a short one is, and the gap under the list is .704 of the gap over it and under the box .88, at every length", () => {
  const { ctx, tickets, pageEl, notch, box, parts } = phoneBoxScript(read("m.html"));
  const lift = () => { ctx.fitList(true); return ctx.listLiftAt().toFixed(2) + "px"; };
  const tiklist = parts.tiklist;
  // as above: the page's top 0 and padding 40, the room 400, the drawer's top at 50, the notch's
  // foot at 30. now a section that fills the list: nothing spare, so the card stands at 440, and
  // its last ticket runs to 500, past the foot of the window the tickets scroll in, at 380. the
  // list's foot is that window's: 10 over the card, its first mark 34.9 under the notch, so it
  // goes up (34.9 - 10) / 2 = 12.45 and its first mark is A = 22.45 under the notch
  pageEl.style.paddingTop = "40px"; tickets.style.top = "50px"; notch.getBoundingClientRect = () => ({ height: 30 });
  ctx.spareRoom = 0; parts.listEnd = 380;
  ctx.drawerPane = () => section(500, 380);
  assert.equal(lift(), "12.45px");
  // the card stays at its lowest and the window reaches .296 of A further down, so its foot is
  // .704 of A over the card (the list's share, a fifth under the box's .88):
  // 440 - .704 * 22.45 - (50 - 12.45 + 380) = 6.645
  assert.ok(Math.abs(ctx.listSlack()) < 1e-9, "the card at its lowest under a full list");
  const reach = parseFloat(tiklist.style.marginBottom.match(/- ([\d.]+)px\)$/)[1]);
  assert.ok(Math.abs(reach - .296 * 22.45) < .01, `the list's reach ${reach}`);
  assert.equal(lift(), "12.45px", "read again with the reach on, the top does not move");
  // a short section is read as before, its last ticket over the window's foot, and lifted as
  // before; the card comes up .296 of A = 28.95 from where it stood: 7 + .296 * 28.95 spare
  ctx.spareRoom = 7; parts.listEnd = 1e9;
  ctx.drawerPane = () => section(360);
  assert.equal(lift(), "5.95px");
  const shortSlack = ctx.listSlack();
  assert.ok(Math.abs(shortSlack - (7 + .296 * 28.95)) < 1e-9, `the card .704 of A under a short list: ${shortSlack}`);
  assert.equal(tiklist.style.marginBottom, "", "a short list reaches no further");
  // the box out over the full list, with words far taller than the drawer: its top edge at the
  // list's first mark (50 + 14.9 - 12.45 = 52.45), and its height what leaves .88 of A = 22.45
  // over the card at its lowest (440): 440 - .88 * 22.45 - 52.45 = 367.794, short of the
  // drawer's 433, so the words scroll inside it
  ctx.spareRoom = 0; parts.listEnd = 380;
  ctx.drawerPane = () => section(500, 380);
  const rooms = [];
  ctx.MagicBox = { fit: (room, want) => { rooms.push(room.height); return { width: room.width, height: Math.min(room.height, 2000) }; } };
  ctx.drawerFace(true);
  assert.ok(Math.abs(rooms.at(-1) - 367.794) < 1e-9, `the box's room ${rooms.at(-1)}`);
  assert.ok(Math.abs(parseFloat(box.style.height) - 367.794) < 1e-9, "the box is fitted to it");
  // so drawn, the card goes to its lowest and stands .88 of A under the box's bottom edge
  box.offsetHeight = parseFloat(box.style.height);
  assert.ok(Math.abs(ctx.listSlack()) < 1e-9, "the card at its lowest");
  const boxTop = 50 - (12.45 - 14.9), cardTop = 40 + 400;
  assert.ok(Math.abs(.88 * (boxTop - 30) - (cardTop - (boxTop + box.offsetHeight))) < 1e-9, "the gap below .88 of the gap above");
  // a box that fits is its own height, under the cap
  ctx.MagicBox = { fit: (room, want) => ({ width: room.width, height: Math.min(room.height, 89) }) };
  ctx.phoneMagicFit();
  assert.equal(box.style.height, "89px");
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

// the phone's box script with every box a picture: what it fetched (asked),
// the pictures it let go (revoked), and pictures that come only when the test
// lets them (slow), each read as 640 x 400
function phoneBoxPictures({ slow = false } = {}) {
  const page = phoneBoxScript(read("m.html"), { drawn: false });
  const { ctx } = page;
  const asked = [], revoked = [], waiting = [];
  let made = 0;
  ctx.fetch = url => {
    asked.push(url);
    const id = new URL(url, "http://phone").searchParams.get("box");
    if (url.startsWith("/magic/img")) {
      const picture = { ok: true, blob: async () => ({}) };
      return slow ? new Promise(r => waiting.push(() => r(picture))) : Promise.resolve(picture);
    }
    const rev = ctx.lastState.boxes.find(b => b.id === id).magic.rev;
    return Promise.resolve({ ok: true, json: async () => ({ box: id, rev, kind: "image", src: `/magic/img?box=${id}&rev=${rev}` }) });
  };
  ctx.URL = { createObjectURL: () => "blob:" + ++made, revokeObjectURL: u => revoked.push(u) };
  ctx.Image = class { decode() { return Promise.resolve(); } get naturalWidth() { return 640; } get naturalHeight() { return 400; } };
  const fetched = kind => asked.filter(u => u.startsWith("/magic/" + kind)).map(u => new URL(u, "http://phone").searchParams.get("box"));
  const near = (build, keep = build) => { ctx.nearbyCards = () => ({ build: new Set(build), keep: new Set(keep) }); };
  const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  const land = async () => { while (waiting.length) waiting.shift()(); await tick(); };
  return { ...page, asked, revoked, fetched, near, tick, land };
}

test("the phone fetches boxes only for the cards it builds, once for each revision, and lets go of the ones it no longer keeps", async () => {
  const { ctx, PB, draws, fetched, near, tick, revoked } = phoneBoxPictures();
  const card = (id, more = {}) => ({ id, owner: "p", done: false, magic: { open: true, rev: 1 }, ...more });
  ctx.lastState = { boxes: ["a", "b", "c", "d", "e", "f", "g"].map(id => card(id)).concat(
    card("shut", { magic: { open: false, rev: 1 } }), card("done", { done: true }), card("other", { owner: "q" }),
    { id: "none", owner: "p", done: false }) };
  // b on show, a and c beside it (and cards that have no open box of this project's)
  ctx.shownId = "b";
  near(["a", "b", "c", "shut", "done", "other", "none"], ["a", "b", "c", "d", "g"]);
  ctx.reachCards();
  await tick();
  assert.deepEqual(fetched("body").sort(), ["a", "b", "c"], "only the open boxes of the cards it builds");
  assert.deepEqual(fetched("img").sort(), ["a", "b", "c"], "and their pictures with them");
  // the next readings build the same cards: nothing is fetched again
  ctx.reachCards(); ctx.reachCards();
  await tick();
  assert.equal(fetched("body").length, 3, "a box was fetched again at the same revision");
  // a new revision on a card beside it: that box alone, once, and its old picture let go
  ctx.lastState.boxes.find(b => b.id === "c").magic = { open: true, rev: 2 };
  ctx.reachCards(); ctx.reachCards();
  await tick();
  assert.deepEqual(fetched("body").sort(), ["a", "b", "c", "c"]);
  assert.equal(revoked.length, 1, "the old revision's picture was kept");
  // the card on show's box is drawn at once, picture and size in hand
  ctx.select();
  assert.equal(draws.length, 1, "the box waited for a fetch it already had");
  assert.deepEqual([...draws[0][1].natural], [640, 400]);
  // a swipe to c: d is built and fetched, a leaves the cards kept and is let go; f, never
  // near, and g, kept but never built, are never fetched
  ctx.shownId = "c";
  near(["b", "c", "d"], ["b", "c", "d", "e"]);
  ctx.select();
  assert.equal(draws.length, 2, "the card beside it was not drawn at once");
  ctx.reachCards();
  await tick();
  assert.deepEqual(fetched("body").sort(), ["a", "b", "c", "c", "d"]);
  assert.ok(!PB.bodies.has("a"), "a card no longer kept still holds its box");
  assert.equal(revoked.length, 2, "its picture was kept");
  assert.ok(!fetched("body").some(id => ["e", "f", "g", "shut", "done", "other", "none"].includes(id)), "a box fetched for a card never built");
  // while a pull or a swipe is going, the building waits, and the fetching with it
  ctx.pullGoing = () => true;
  near(["c", "d", "e"]);
  ctx.reachCards();
  await tick();
  assert.equal(fetched("body").length, 5, "a box was fetched during a pull");
  ctx.pullGoing = () => false;
  ctx.reachCards();
  await tick();
  assert.deepEqual(fetched("body").sort(), ["a", "b", "c", "c", "d", "e"]);
  // nothing was ever fetched for another card, and the page's own reading fetches no box
  ctx.apply({});
  await tick();
  assert.equal(fetched("body").length, 6);
});

test("the card on show's box is fetched first, and the cards beside it wait for it", async () => {
  const { ctx, fetched, near, tick, land } = phoneBoxPictures({ slow: true });
  ctx.lastState = { boxes: ["a", "b", "c"].map(id => ({ id, owner: "p", done: false, magic: { open: true, rev: 1 } })) };
  near(["b", "a", "c"]);
  ctx.select();
  ctx.reachCards();
  await tick();
  assert.deepEqual(fetched("body"), ["a"], "a card beside it shared the line with the box on show");
  assert.deepEqual(fetched("img"), ["a"]);
  await land();
  assert.deepEqual(fetched("body").sort(), ["a", "b", "c"], "the cards beside it were not fetched once it was in");
  ctx.reachCards();
  await land();
  assert.equal(fetched("body").length, 3);
});

test("a box not ready yet is held: the drawer never comes out tall and blank, and it comes out at its own size once its picture is in", async () => {
  const fire = (ctx, listeners, type, e) => { for (const l of listeners[type] || []) l.fn(e); };
  const at = (x, y = 400) => ({ touches: [{ clientX: x, clientY: y }], timeStamp: 0 });
  const press = ctx => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; ctx.phoneShortcutActions.boxDrawer(e); return e.prevented; };
  // a pull from the right edge as the card arrives, before its picture is in
  let p = phoneBoxPictures({ slow: true });
  p.ctx.select();
  await p.tick();
  fire(p.ctx, p.listeners, "touchstart", at(398));
  assert.ok(!p.classes.has("boxface") && p.tickets.dataset.side === "left", "the drawer took the box's face before it was ready");
  fire(p.ctx, p.listeners, "touchmove", at(300));
  fire(p.ctx, p.listeners, "touchend", { timeStamp: 0 });
  assert.ok(!p.calls.some(c => String(c).startsWith("show")), "the drawer came out with nothing to show");
  assert.ok(!p.paneClasses.has("nudge"), "the card dipped as if it had no box");
  assert.equal(p.draws.length, 0);
  await p.land();
  assert.deepEqual(p.calls.filter(c => String(c).startsWith("show")), ["show box from the right"], "the held box did not come out");
  assert.deepEqual([...p.draws.at(-1)[1].natural], [640, 400], "it came out without its picture's size");
  // the key as the card arrives: held the same way, and it comes out once
  p = phoneBoxPictures({ slow: true });
  p.ctx.select();
  await p.tick();
  assert.equal(press(p.ctx), true, "the key was left to type a period");
  assert.ok(!p.calls.some(c => String(c).startsWith("show")) && !p.paneClasses.has("nudge"));
  await p.land();
  assert.deepEqual(p.calls.filter(c => String(c).startsWith("show")), ["show box from the right"]);
  // the key again lets it go, and so does a touch anywhere else, the list, or another card
  for (const letGo of [
    p => press(p.ctx),
    p => fire(p.ctx, p.listeners, "touchstart", at(200)),
    p => p.ctx.openDrawer(),
    p => { p.ctx.shownId = "b"; p.ctx.select(); p.ctx.shownId = "a"; },
  ]) {
    p = phoneBoxPictures({ slow: true });
    p.ctx.select();
    await p.tick();
    press(p.ctx);
    letGo(p);
    await p.land();
    assert.ok(!p.calls.some(c => String(c).startsWith("show box")), "a box let go came out: " + letGo);
  }
});

test("the Mac box's words can be selected and copied, and command+a picks only them", () => {
  const html = read("index.html");
  const optIn = html.match(/\.reply, \.mreply[^{]*\{\s*-webkit-user-select:text; user-select:text;/);
  assert.ok(optIn && /#magicbox \.mbtext/.test(optIn[0]), "the box's words opt back in to selection");
  assert.ok(/getSelection\(\)\.selectAllChildren\(words\)/.test(html), "command+a selects the box's words alone");
});

test("the Mac's box hides every scrollbar and a page wider than it scrolls sideways; the phone's page is as it was", () => {
  const MB = api();
  const mac = MB.pageDoc("<p>x</p>", "w", true), phone = MB.pageDoc("<p>x</p>", "w", false);
  assert.ok(mac.includes("<style>*{scrollbar-width:none}*::-webkit-scrollbar{display:none}html{overflow-x:auto}</style>"));
  assert.ok(mac.indexOf("<style>") < mac.indexOf("<p>x</p>"), "the agent's styles come after");
  // auto, not hidden: what runs past the box's right edge is scrolled to, not
  // clipped. and not visible either: a non-visible root keeps a body's own
  // overflow on the body, as hidden did, so a page that fits is laid out as before
  const rule = mac.match(/html\{overflow-x:([a-z]+)\}/g);
  assert.deepEqual(rule, ["html{overflow-x:auto}"], "one sideways rule, and it scrolls");
  assert.ok(!/overflow-x:hidden|overflow:hidden/.test(mac.slice(0, mac.indexOf("<p>x</p>"))), "nothing of the board's clips the page");
  assert.ok(!/scrollbar|overflow-x/.test(phone), "the phone's page is unchanged");
  assert.ok(!/scrollbar|overflow-x/.test(MB.pageDoc("<p>x</p>", "w", false, true)), "and so is the phone's tall page");
  const html = read("index.html");
  // the box's own body still never scrolls sideways: the page scrolls inside its frame, which fills it
  assert.match(html, /#magicbox, #magicbox \*\{scrollbar-width:none\}\s*#magicbox::-webkit-scrollbar, #magicbox \*::-webkit-scrollbar\{display:none\}\s*#magicbox \.mbbody\{overflow-x:hidden\}/);
  assert.match(read("card-tokens.css"), /\.magicbox \.mbframe\{display:block; width:100%; height:100%;/);
  // the runbook gives agents the box's real width: full size beside the board's
  // card, down to the narrowest box still shown, half the card's height tall
  assert.equal(Math.round(CARD.height * WIDE), 386);
  assert.equal(Math.round(CARD.height / 2 * SHAPE), 205);
  assert.match(read("RUNBOOK.md"), /The box is narrow: on the Mac board a page is laid out between about 205 and 386 pixels wide \(386 when/);
});

test("on the phone a page taller than the box is laid out at its own height, takes a finger itself and the box scrolls it", () => {
  const MB = api();
  // the phone's page says its height and nothing more: no keys relayed, no calm
  const tall = MB.pageDoc("<p>x</p>", "w", false, true);
  assert.match(tall, /parent\.postMessage\(W \+ ' ' \+ h, '\*'\)/);
  assert.ok(!/ArrowLeft|' create'|scrollbar/.test(tall));
  assert.match(read("m.html"), /PB\.view = magicView\(PB\.el, \{ placed: \(\) => phoneMagicFit\(\), tall: true,/);
  // a second tap on the page never zooms the phone page, ahead of the agent's
  // own styles; the Mac's page and a page with neither are left as they were
  const taps = "<style>*{touch-action:manipulation}</style>";
  assert.ok(tall.includes(taps) && tall.indexOf(taps) < tall.indexOf("<p>x</p>"));
  assert.ok(!MB.pageDoc("<p>x</p>", "w", true).includes("touch-action") && !MB.pageDoc("<p>x</p>", "w").includes("touch-action"));
  // the sheet: frame and a site's cover as tall as the page, never shorter
  // than the box. an agent's page wears no cover, which no finger takes off
  const m = read("m.html");
  assert.match(m, /#mbface \.mbframe, #mbface \.mbcover\{height:max\(100%, var\(--mb-page, 0px\)\)\}\s*#mbface \.mbcover\{bottom:auto\}/);
  assert.match(m, /#mbface \.mbbody\[data-kind="html"\] > \.mbcover\{display:none\}/);
  assert.ok(!/#mbface[^{}]*\[data-kind="url"\][^{}]*\.mbcover\{display:none\}/.test(m), "a site keeps its cover");
  // and the view: the height the page says goes on the body, a new page starts
  // from none, and a page that keeps growing past its frame by the same amount is stopped
  const body = { style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
    textContent: "", dataset: { kind: "html" }, append() {}, addEventListener() {}, querySelector() { return null; } };
  const el = { querySelector: s => s === ".mbbody" ? body : null, lastElementChild: null };
  let onMessage = null;
  const frames = [];
  const ctx = vm.createContext({
    MagicBox: MB, getComputedStyle: () => ({ getPropertyValue: () => "0" }), setTimeout() {}, Date,
    addEventListener: (type, f) => { if (type === "message") onMessage = f; },
    h: () => { const f = { setAttribute() {}, addEventListener() {}, clientHeight: 500, contentWindow: {} }; frames.push(f); return f; },
  });
  vm.runInContext(read("card-logic.js").match(/function magicView\(el, hooks = \{\}\)\{[\s\S]*?\n  return view;\n\}/)[0] + ";this.magicView = magicView;", ctx);
  let placed = 0;
  const view = ctx.magicView(el, { tall: true, placed: () => placed++ });
  view.draw({ kind: "html", html: "<p>x</p>" });
  const run = view.page, say = h => onMessage({ source: run.frame.contentWindow, data: run.word + " " + h });
  assert.match(run.frame.srcdoc, /new ResizeObserver\(say\)/, "the phone's frame is asked its height");
  say(2400);
  assert.equal(body.style.props["--mb-page"], "2400px", "laid out as tall as it says");
  assert.equal(placed, 1);
  // the frame grown to it: a picture arriving makes it taller again
  run.frame.clientHeight = 2400; say(2700);
  assert.equal(body.style.props["--mb-page"], "2700px");
  // a page that follows its frame (a full height in it) stops growing
  run.frame.clientHeight = 2700; say(2740);
  run.frame.clientHeight = 2740; say(2780);
  run.frame.clientHeight = 2780; say(2820);
  assert.equal(body.style.props["--mb-page"], "2780px", "a page chasing its own frame is held");
  view.draw({ kind: "html", html: "<p>y</p>" });
  assert.equal(body.style.props["--mb-page"], undefined, "a new page starts at the box's own height");
});

// ---- the box expanded ---------------------------------------------------------
// a green button at the other end of the box's bar from the cross, the top left
// on the board and the bottom left on the phone, expands the box over the
// dimmed board: nine tenths of the Mac's window and 95% of the phone's screen,
// in the middle, with what it holds laid out again at that size. the same
// button, Escape or a click on the shade puts it back
const flat = o => JSON.parse(JSON.stringify(o));

test("expanded, the box is nine tenths of the Mac's window and 95% of the phone's screen, in the middle", () => {
  const { BIG, grow } = api();
  assert.equal(BIG.mac, 0.9);
  assert.equal(BIG.phone, 0.95);
  const mac = flat(grow({ left: 0, top: 0, width: 1512, height: 982 }, BIG.mac));
  assert.ok(close(mac.width, 1360.8) && close(mac.height, 883.8), "nine tenths each way");
  assert.ok(close(mac.left, 75.6) && close(mac.top, 49.1), "the same margin either side");
  const phone = flat(grow({ left: 0, top: 0, width: 375, height: 812 }, BIG.phone));
  assert.ok(close(phone.width, 356.25) && close(phone.height, 771.4));
  assert.ok(close(phone.left, 9.375) && close(phone.top, 20.3));
  // a room that does not start at the window's corner keeps the box in its own middle
  const off = flat(grow({ left: 100, top: 40, width: 1000, height: 600 }, BIG.mac));
  assert.ok(close(off.left + off.width / 2, 600) && close(off.top + off.height / 2, 340));
});

test("on the phone the expanded box keeps inside the safe areas, clear of the notch and the home bar", () => {
  const { BIG, grow } = api();
  const screen = { left: 0, top: 0, width: 375, height: 812 }, safe = { left: 0, top: 50, width: 375, height: 812 - 50 - 34 };
  const at = flat(grow(screen, BIG.phone, false, safe));
  assert.ok(close(at.left, 9.375) && close(at.width, 356.25), "across, 95% of the screen");
  assert.equal(at.top, 50, "under the notch");
  assert.equal(at.top + at.height, 812 - 34, "over the home bar");
  const whole = grow(screen, BIG.phone, false, screen), exact = grow(screen, BIG.phone);
  for (const k of ["left", "top", "width", "height"]) assert.ok(close(whole[k], exact[k]), "no safe areas, 95% exactly: " + k);
});

test("a site that will not be framed stays a square when expanded, as large as the shorter side allows, in the middle", () => {
  const { BIG, grow } = api();
  const at = flat(grow({ left: 0, top: 0, width: 1512, height: 982 }, BIG.mac, true));
  assert.ok(close(at.width, 883.8) && close(at.height, 883.8));
  assert.ok(close(at.left + at.width / 2, 756) && close(at.top + at.height / 2, 491));
  const phone = flat(grow({ left: 0, top: 0, width: 375, height: 812 }, BIG.phone, true, { left: 0, top: 50, width: 375, height: 728 }));
  assert.ok(close(phone.width, 356.25) && close(phone.height, 356.25));
  assert.ok(close(phone.top + phone.height / 2, 50 + 728 / 2), "in the middle of the safe part");
});

test("the green button mirrors the cross at the bar's other end: its seat, ink, shade, outline and reach, in a soft green", () => {
  const sheet = boxSheet();
  const rule = sel => sheet.match(new RegExp("\\n" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}"))[1].replace(/\s+/g, " ");
  const cross = rule(".magicbox .mbclose"), grow = rule(".magicbox .mbgrow");
  for (const part of ["position:relative", "flex:none", "display:grid", "place-items:center", "width:var(--mb-x)",
    "height:var(--mb-x)", "padding:0", "border:none", "border-radius:50%", "color:#1e1e1e", "cursor:pointer"])
    assert.ok(cross.includes(part) && grow.includes(part), part);
  assert.match(grow, /background:var\(--mb-green\)/);
  assert.match(grow, /margin-right:auto/, "it stands at the bar's left, and the cross stays at its right");
  assert.match(sheet, /\.magicbox \.mbgrow:hover, \.magicbox \.mbgrow:active\{background:color-mix\(in srgb, #000 var\(--press\), var\(--mb-green\)\)\}/);
  assert.match(sheet, /\.magicbox \.mbgrow:focus-visible\{outline:2px solid var\(--line\); outline-offset:1px\}/);
  assert.match(sheet, /\.magicbox \.mbgrow svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/);
  assert.match(sheet, /\.magicbox \.mbgrow::after\{content:""; position:absolute; inset:-8px\}/);
  // the bar itself is as it was: the cross at its right
  assert.match(sheet.match(/\.magicbox \.mbbar\{([^}]*)\}/)[1], /justify-content:flex-end/);
  // a soft green: light, more green than red or blue, and never the accent purple
  const green = sheet.match(/--mb-green:#([0-9A-F]{6});/i)[1];
  const [r, g, b] = [0, 2, 4].map(i => parseInt(green.slice(i, i + 2), 16));
  assert.ok(g > r + 40 && g > b + 30, "green");
  assert.ok((Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255 > 0.6, "pastel, as light as the cross's soft red");
  assert.ok(!/432BFF/i.test(sheet), "never the accent purple");
  // on the phone it is the cross's mirror at the bottom left corner
  const phone = read("m.html");
  assert.match(phone, /#mbface \.mbbar\{padding:0 var\(--mb-seat\)\}/);
  assert.match(phone, /#mbface :is\(\.mbclose, \.mbgrow\)\{top:calc\(var\(--mb-gap\) - var\(--mb-seat\)\)\}/);
});

// the shared view, its marks and its expand, on stand-ins
function expandView(hooks = {}) {
  const logic = read("card-logic.js");
  const src = logic.slice(logic.indexOf("const MAGIC_CROSS = "), logic.indexOf("// a site's name as the site gives it"))
    + logic.slice(logic.indexOf("function magicView("), logic.indexOf("\n}\n", logic.indexOf("function magicView(")) + 3);
  const classes = new Set(), body = { dataset: {}, style: { setProperty() {} }, addEventListener() {}, querySelector: () => null };
  const grow = { innerHTML: "", label: "", setAttribute(k, v) { if (k === "aria-label") grow.label = v; } };
  const el = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    querySelector: s => s === ".mbbody" ? body : s === ".mbgrow" ? grow : { innerHTML: "" } };
  const ctx = vm.createContext({ getComputedStyle: () => ({ getPropertyValue: () => "0" }), addEventListener() {}, h() {}, MagicBox: {} });
  vm.runInContext(src, ctx);
  const view = ctx.magicView(el, hooks);
  return { view, grow, classes, marks: { grow: vm.runInContext("MAGIC_GROW", ctx), shrink: vm.runInContext("MAGIC_SHRINK", ctx) } };
}

test("the button's mark is the expand mark at the box's size and the reduce mark while it is expanded", () => {
  const { view, grow, classes, marks } = expandView();
  for (const mark of [marks.grow, marks.shrink]) {
    assert.match(mark, /^<svg viewBox="0 0 10 10" fill="currentColor"/, "the cross's 10 grid, in the button's ink");
    assert.equal((mark.match(/Z/g) || []).length, 2, "two triangles");
  }
  // expand: the square corners out at the top left and the bottom right; reduce: in, meeting in the middle
  assert.match(marks.grow, /M1\.8 1\.8H6L1\.8 6ZM8\.2 8\.2H4L8\.2 4Z/);
  assert.match(marks.shrink, /M4\.2 4\.2H0\.8L4\.2 0\.8ZM5\.8 5\.8H9\.2L5\.8 9\.2Z/);
  assert.equal(grow.innerHTML, marks.grow, "drawn into the button as the box is made");
  assert.equal(view.big, false);
  view.expand(true);
  assert.equal(view.big, true);
  assert.ok(classes.has("big"));
  assert.equal(grow.innerHTML, marks.shrink);
  assert.equal(grow.label, "Reduce the magic box");
  view.expand(false);
  assert.ok(!classes.has("big"));
  assert.equal(grow.innerHTML, marks.grow);
  assert.equal(grow.label, "Expand the magic box");
});

test("an agent's page the board sizes the box to keeps the height it said at the box's own width while it is expanded", () => {
  const { view } = expandView({ sized: true });
  view.page = { height: 640 };
  view.expand(true);
  view.page.height = 300;   // what it says laid out at the expanded width
  view.expand(false);
  assert.equal(view.page.height, 640, "the box comes back at the height it had");
  // and a page is never waited for while the box is expanded, whose size is not the page's
  assert.match(read("card-logic.js"), /if \(hooks\.sized && !view\.big && run && view\.body\.dataset\.kind === "html" && !run\.height/);
  // the phone lays its page out as tall as the page says, at any width, so nothing is kept there
  const phone = expandView({ tall: true }).view;
  phone.page = { height: 640 };
  phone.expand(true); phone.page.height = 300; phone.expand(false);
  assert.equal(phone.page.height, 300);
});

test("Escape typed in an agent's page is said to the board, unless the page answered it itself", () => {
  const { pageDoc } = api();
  for (const doc of [pageDoc("<p>x</p>", "w", true), pageDoc("<p>x</p>", "w", false, true)]) {
    const hello = doc.slice(doc.indexOf('<script>addEventListener("load"') + 8, doc.indexOf("</script>", doc.indexOf('<script>addEventListener("load"')));
    // (the Mac's page also says its keys for control+S, which are not Escape's)
    const keys = [], posted = [], later = [];
    const on = (type, fn, capture) => { if (type === "keydown") keys.push({ fn, capture }); };
    const ctx = vm.createContext({ addEventListener: on, document: { addEventListener() {} },
      parent: { postMessage: m => { if (!/^w key /.test(m)) posted.push(m); } }, setTimeout: fn => later.push(fn) });
    vm.runInContext(hello, ctx);
    const press = e => { for (const k of keys) k.fn({ key: "", isComposing: false, defaultPrevented: false, ...e }); later.splice(0).forEach(f => f()); };
    press({ key: "Escape" });
    assert.deepEqual(posted, ["w escape"], "said once, as the word, a space and escape");
    press({ key: "Escape", defaultPrevented: true });
    press({ key: "Escape", isComposing: true });
    press({ key: "a" });
    assert.deepEqual(posted, ["w escape"], "a page's own Escape, a composition and other keys are its own");
  }
  // the view hands it to the board's hook
  assert.match(read("card-logic.js"), /else if \(e\.data === run\.word \+ " escape"\)\{ if \(hooks\.escape\) hooks\.escape\(\); \}/);
});

// the shared view with a picture in it, on a small model of the box: its body
// 1000 by 600 in its own pixels, drawn at the screen's (100, 50) at the
// stage's scale; an image box's picture is 2000 by 1000, fitted in it (as
// large as fits, never past its own size) at 1000 by 500, 50 down. a markdown
// box holds words with that picture in them. events go straight to the body's
// listeners, aimed at what they name. the clock is the test's
function zoomBox({ kind = "image", scale = 1, hooks = {} } = {}) {
  const logic = read("card-logic.js"), at = s => logic.indexOf(s);
  const src = logic.slice(at("const CARD_PICTURES"), at("let cardPictureShown"))
    + logic.slice(at("const MAGIC_CROSS = "), at("// a site's name as the site gives it"))
    + logic.slice(at("function magicView("), logic.indexOf("\n}\n", at("function magicView(")) + 3);
  const listeners = {};
  const make = (tag, cls = "", parent = null) => {
    const classes = new Set(cls.split(" ").filter(Boolean));
    const n = { tag, parent, children: [], style: {}, dataset: {}, anims: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
        contains: c => classes.has(c), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)) },
      appendChild(c) { c.parent = n; n.children.push(c); return c; },
      remove() { if (n.parent) n.parent.children = n.parent.children.filter(x => x !== n); n.parent = null; },
      querySelector(sel) {
        if (sel.startsWith(":scope > .")) return n.children.find(k => k.classList.contains(sel.slice(10))) || null;
        const walk = k => { for (const x of k.children) { if (x.classList.contains(sel.slice(1))) return x; const f = walk(x); if (f) return f; } return null; };
        return walk(n);
      },
      closest(sel) { for (let k = n; k; k = k.parent) if (k.classList.contains(sel.slice(1))) return k; return null; },
      animate(keys, opts) { const a = { keys, opts, cancelled: false, finish() {}, cancel() { a.cancelled = true; } }; n.anims.push(a); return a; },
      setPointerCapture() { n.captured = true; } };
    Object.defineProperty(n, "className", { get: () => [...classes].join(" "), set: v => { classes.clear(); v.split(" ").filter(Boolean).forEach(x => classes.add(x)); } });
    Object.defineProperty(n, "textContent", { get: () => "", set: () => { n.children = []; } });
    if (parent) parent.children.push(n);
    return n;
  };
  const el = make("section", "magicbox"), bar = make("div", "mbbar", el), body = make("div", "mbbody", el);
  Object.assign(el, { lastElementChild: body, offsetWidth: 1002, clientWidth: 1000 });
  bar.offsetHeight = 30;
  Object.assign(body, { offsetWidth: 1000, clientLeft: 0, clientTop: 0, style: { setProperty() {} },
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 1000 * scale, height: 600 * scale }),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); } });
  body.dataset.kind = kind;
  const picture = img => Object.assign(img, { offsetWidth: 1000, offsetHeight: 600, offsetLeft: 0, offsetTop: 0,
    naturalWidth: 2000, naturalHeight: 1000, complete: true, src: "/magic/chart.png" });
  let words = null, shot = null;
  if (kind === "image") picture(make("img", "mbimg", body));
  else {
    words = make("div", "mbtext cardmd", body);
    shot = Object.assign(make("img", "shot", words), { src: "/uploads/chart.png", alt: "chart", naturalWidth: 2000, complete: true });
    // the words are 700 tall laid out, and nothing while a picture stands alone over them
    Object.defineProperty(words, "offsetHeight", { get: () => body.classList.contains("alone") ? 0 : 700 });
  }
  let now = 0;
  const flags = { still: false, moving: false }, observers = [];
  const ctx = vm.createContext({ MagicBox: {}, window: {}, innerHeight: 800,
    ResizeObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    Date: class extends Date { static now() { return now; } },
    cardPictureStill: () => flags.still,
    getComputedStyle: n => ({ getPropertyValue: () => "0", paddingTop: "0px", paddingBottom: "0px",
      marginTop: body.classList.contains("alone") ? "0px" : "8px", marginBottom: "0px", transform: n.style.transform || "none" }),
    document: { createElement: tag => make(tag) },
    h: (tag, cls) => make(tag, cls), addEventListener() {} });
  vm.runInContext(src, ctx);
  const view = ctx.magicView(el, { moving: () => flags.moving, ...hooks });
  const img = () => body.querySelector(":scope > .mbimg");
  // an event on the picture, or on what it names, with the screen's point (x, y)
  const send = (type, more = {}) => {
    const e = { type, target: img(), clientX: 0, clientY: 0, button: 0, buttons: 0, pointerType: "mouse", ctrlKey: false, metaKey: false,
      deltaX: 0, deltaY: 0, deltaMode: 0, touches: [], defaultPrevented: false, stopped: false,
      preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.stopped = true; }, ...more };
    for (const fn of listeners[type] || []) fn(e);
    return e;
  };
  const fingers = (type, points) => send(type, { touches: points.map(([x, y]) => ({ clientX: x, clientY: y })) });
  // where the picture is drawn, in the body's pixels: its transform, its shift
  // a share of its own box (1000 by 600), laid over its fit
  const drawn = () => {
    const t = img().style.transform || "";
    if (t) assert.match(t, /^translate\(-?[\d.e-]+%, -?[\d.e-]+%\) scale\([\d.e-]+\)$/);
    const [x, y, k] = t ? t.match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number) : [0, 0, 1];
    return { x: x / 100 * 1000 + k * 0, y: y / 100 * 600 + k * 50, w: k * 1000, h: k * 500, k };
  };
  return { view, el, body, words, shot, img, send, fingers, drawn, flags, tick: ms => { now += ms; },
    resized: () => observers.forEach(fn => fn()) };
}

test("expanded, the picture in the box zooms about the pointer, a pinch or command and the wheel, from its fit to four times that", () => {
  const { view, send, drawn, flags, img } = zoomBox();
  // at the box's own size the wheel is the page's, and so it is while the box is on its way
  let e = send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  assert.equal(e.defaultPrevented, false);
  assert.equal(img().style.transform, undefined);
  view.expand(true);
  flags.moving = true;
  e = send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  assert.equal(e.defaultPrevented, false, "not while the box is on its way");
  flags.moving = false;
  // the point under the pointer (500, 250 in the body: half across the picture, two fifths down) stays under it
  e = send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  assert.equal(e.defaultPrevented, true, "the page itself never zooms");
  let d = drawn();
  assert.ok(close(d.k, Math.exp(0.6), 1e-9), "e^(-deltaY / 100), as the full-screen picture zooms");
  assert.ok(close((500 - d.x) / d.w, 0.5, 1e-9) && close((250 - d.y) / d.h, 0.4, 1e-9), JSON.stringify(d));
  assert.ok(img().classList.contains("zoomed"));
  // command and the wheel zoom the same way
  send("wheel", { metaKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  assert.ok(close(drawn().k, Math.exp(1.2), 1e-9));
  // back down no further than its fit
  for (let i = 0; i < 10; i++) send("wheel", { ctrlKey: true, deltaY: 4000, clientX: 600, clientY: 300 });
  assert.equal(img().style.transform, "", "fitted again: no transform at all");
  assert.ok(!img().classList.contains("zoomed"));
  // one wheel counts for no more than 60, and four times its fit is the most
  send("wheel", { ctrlKey: true, deltaY: -4000, clientX: 600, clientY: 300 });
  assert.ok(close(drawn().k, Math.exp(0.6), 1e-9));
  for (let i = 0; i < 5; i++) send("wheel", { ctrlKey: true, deltaY: -4000, clientX: 600, clientY: 300 });
  assert.ok(close(drawn().k, 4, 1e-9));
  // the stage's scale is counted out: on a stage at .8 the same point stays under the pointer
  const small = zoomBox({ scale: 0.8 });
  small.view.expand(true);
  small.send("wheel", { ctrlKey: true, deltaY: -60, clientX: 100 + 500 * .8, clientY: 50 + 250 * .8 });
  d = small.drawn();
  assert.ok(close((500 - d.x) / d.w, 0.5, 1e-9) && close((250 - d.y) / d.h, 0.4, 1e-9), JSON.stringify(d));
});

test("zoomed, the picture moves with a drag, one finger or a two-finger scroll, never so far that an edge comes in past the box's", () => {
  const { view, send, fingers, drawn, img } = zoomBox({ scale: 0.8 });
  view.expand(true);
  // fitted there is nothing to move: a two-finger scroll is left alone and a drag moves nothing
  assert.equal(send("wheel", { deltaY: 40 }).defaultPrevented, false);
  send("pointerdown", { clientX: 500, clientY: 300, buttons: 1 });
  send("pointermove", { clientX: 400, clientY: 200, buttons: 1 });
  send("pointerup", { clientX: 400, clientY: 200 });
  send("click", { clientX: 400, clientY: 200 });
  assert.equal(img().style.transform, undefined);
  send("wheel", { ctrlKey: true, deltaY: -60, clientX: 500, clientY: 300 });
  send("wheel", { ctrlKey: true, deltaY: -60, clientX: 500, clientY: 300 });
  let was = drawn();
  // a two-finger scroll, in screen pixels, moved in the box's own (the stage at .8)
  const e = send("wheel", { deltaX: 40, deltaY: -16, clientX: 500, clientY: 300 });
  assert.equal(e.defaultPrevented, true);
  let d = drawn();
  assert.ok(close(d.x, was.x - 50, 1e-6) && close(d.y, was.y + 20, 1e-6), JSON.stringify([was, d]));
  // a dragged mouse, held from the press on: the picture is held, picks no words and drags nothing out
  was = d;
  send("pointerdown", { clientX: 500, clientY: 300, buttons: 1, pointerId: 3 });
  assert.ok(img().captured && img().classList.contains("dragging"));
  assert.equal(send("mousedown", { clientX: 500, clientY: 300 }).defaultPrevented, true);
  assert.equal(send("dragstart").defaultPrevented, true);
  send("pointermove", { clientX: 520, clientY: 310, buttons: 1 });
  send("pointermove", { clientX: 540, clientY: 320, buttons: 1 });
  d = drawn();
  assert.ok(close(d.x, was.x + 50, 1e-6) && close(d.y, was.y + 25, 1e-6), JSON.stringify([was, d]));
  send("pointerup", { clientX: 540, clientY: 320 });
  assert.ok(!img().classList.contains("dragging"));
  // the click that ends a drag is no tap: a second click soon after is a first one
  send("click", { clientX: 540, clientY: 320 });
  send("click", { clientX: 540, clientY: 320 });
  assert.ok(drawn().k > 1, "still zoomed");
  // dragged far each way it stops with its edge at the box's, so some of it always shows
  send("pointerdown", { clientX: 500, clientY: 300, buttons: 1 });
  send("pointermove", { clientX: 5000, clientY: 4000, buttons: 1 });
  d = drawn();
  assert.ok(close(d.x, 0, 1e-6) && close(d.y, 0, 1e-6), "its top left corner at the box's: " + JSON.stringify(d));
  send("pointermove", { clientX: -9000, clientY: -9000, buttons: 1 });
  d = drawn();
  assert.ok(close(d.x + d.w, 1000, 1e-6) && close(d.y + d.h, 600, 1e-6), "its bottom right corner at the box's: " + JSON.stringify(d));
  send("pointerup", {});
  // one finger moves it too
  was = d;
  fingers("touchstart", [[500, 300]]);
  fingers("touchmove", [[520, 300]]);
  fingers("touchmove", [[540, 324]]);
  d = drawn();
  assert.ok(close(d.x, was.x + 50, 1e-6) && close(d.y, was.y + 30, 1e-6), JSON.stringify([was, d]));
  fingers("touchend", []);
});

test("a double click or a double tap takes the picture from its fit to twice at that point and back; a lone one does nothing", () => {
  const { view, send, fingers, drawn, img, tick, flags } = zoomBox();
  view.expand(true);
  // a lone click, or two too far apart in time or place, does nothing, and never puts the box back
  send("click", { clientX: 600, clientY: 300 });
  tick(400);
  send("click", { clientX: 600, clientY: 300 });
  tick(100);
  send("click", { clientX: 700, clientY: 300 });
  assert.equal(img().style.transform, undefined);
  assert.equal(view.big, true);
  tick(1000);
  send("click", { clientX: 600, clientY: 300 });
  tick(150);
  send("click", { clientX: 610, clientY: 305 });
  let d = drawn();
  assert.ok(close(d.k, 2, 1e-9), "twice its fit");
  assert.ok(close((510 - d.x) / d.w, 0.51, 1e-9), "about the second click");
  // carried there on the picture's own time and curve
  const grow = img().anims.at(-1);
  assert.deepEqual(flat(grow.opts), { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  assert.equal(flat(grow.keys)[1].transform, img().style.transform);
  tick(1000);
  send("click", { clientX: 600, clientY: 300 });
  tick(150);
  send("click", { clientX: 600, clientY: 300 });
  assert.equal(img().style.transform, "", "back to its fit");
  // the fingers: a double tap the same way
  tick(1000);
  for (const t of [0, 150]) { tick(t); fingers("touchstart", [[600, 300]]); fingers("touchend", []); }
  assert.ok(close(drawn().k, 2, 1e-9));
  // with reduced motion it goes there at once
  flags.still = true;
  const n = img().anims.length;
  tick(1000);
  for (const t of [0, 150]) { tick(t); fingers("touchstart", [[600, 300]]); fingers("touchend", []); }
  assert.equal(img().style.transform, "");
  assert.equal(img().anims.length, n);
});

test("two fingers pinch the expanded picture about their middle, and every touch on it is its own", () => {
  const { view, fingers, drawn, img } = zoomBox();
  // at the box's own size the touches are the page's: a tap expands the box (the page guard)
  let e = fingers("touchstart", [[600, 300]]);
  assert.ok(!e.defaultPrevented && !e.stopped);
  fingers("touchend", []);
  view.expand(true);
  e = fingers("touchstart", [[550, 300], [650, 300]]);
  assert.ok(e.defaultPrevented && e.stopped, "no scroll, no page zoom, no pull of the drawer, no click");
  e = fingers("touchmove", [[500, 300], [700, 300]]);
  assert.ok(e.defaultPrevented && e.stopped);
  let d = drawn();
  assert.ok(close(d.k, 2, 1e-9), "spread twice as far: twice its fit");
  assert.ok(close((500 - d.x) / d.w, 0.5, 1e-9) && close((250 - d.y) / d.h, 0.4, 1e-9), "about their middle");
  // the middle carries it: both fingers moved down 30
  fingers("touchmove", [[500, 330], [700, 330]]);
  const was = d;
  d = drawn();
  assert.ok(close(d.y, was.y + 30, 1e-6) && close(d.x, was.x, 1e-6));
  // the finger left of two goes on moving it
  fingers("touchend", [[700, 330]]);
  fingers("touchmove", [[690, 330]]);
  assert.ok(close(drawn().x, was.x - 10, 1e-6));
  e = fingers("touchend", []);
  assert.ok(e.defaultPrevented && e.stopped);
  // spread past four times it stops there
  fingers("touchstart", [[590, 300], [610, 300]]);
  fingers("touchmove", [[100, 300], [1100, 300]]);
  assert.ok(close(drawn().k, 4, 1e-9));
  fingers("touchend", []);
  assert.ok(img().classList.contains("zoomed"));
});

test("the box going back carries the picture back to its fit as it shrinks, a new size lets go of a zoom, and it opens fitted", () => {
  const { view, send, img, flags, resized } = zoomBox();
  view.expand(true);
  send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  const zoomed = img().style.transform;
  view.expand(false);
  assert.equal(img().style.transform, "");
  assert.ok(!img().classList.contains("zoomed"));
  const back = img().anims.at(-1);
  assert.deepEqual(flat(back.keys), [{ transform: zoomed }, { transform: "none" }], "from where it stood");
  assert.deepEqual(flat(back.opts), { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" }, "on the box's own time and curve");
  // the shift is a share of the picture's own box, so as the box shrinks under it the zoomed picture
  // shrinks with it: dragged to its bottom right corner at four times, the same transform on a box half
  // the size still holds that corner at the box's (in pixels it slid off to the top left, leaving the box white)
  view.expand(true);
  for (let i = 0; i < 4; i++) send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  send("pointerdown", { clientX: 600, clientY: 300, buttons: 1 });
  send("pointermove", { clientX: -9000, clientY: -9000, buttons: 1 });
  send("pointerup", {});
  const corner = img().style.transform, [sx, sy, sk] = corner.match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number);
  assert.ok(close(sk, 4, 1e-9));
  // exactly at the box's own shape, and within a pixel at a shape a little different
  for (const [W, H, by] of [[1000, 600, 1e-6], [500, 300, 1e-6], [250, 150, 1e-6], [386, 232, 1]]) {
    const fit = Math.min(W / 2000, H / 1000), fw = 2000 * fit, fh = 1000 * fit, fx = (W - fw) / 2, fy = (H - fh) / 2;
    assert.ok(close(sx / 100 * W + sk * fx + sk * fw, W, by) && close(sy / 100 * H + sk * fy + sk * fh, H, by),
      "the picture's bottom right corner at the box's, the box " + W + " by " + H);
    assert.ok(sx / 100 * W + sk * fx <= 0 && sy / 100 * H + sk * fy <= 0, "and the picture still covers the box");
  }
  view.expand(false);
  assert.deepEqual(flat(img().anims.at(-1).keys), [{ transform: corner }, { transform: "none" }]);
  // expanded again it opens at its fit; with reduced motion the way back is at once
  view.expand(true);
  assert.equal(img().style.transform, "");
  send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  flags.still = true;
  const n = img().anims.length;
  view.expand(false);
  assert.equal(img().style.transform, "");
  assert.equal(img().anims.length, n);
  // the box laid out at another size lets go of the zoom
  flags.still = false;
  view.expand(true);
  send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  resized();
  assert.ok(img().style.transform, "the same size keeps it");
  img().offsetWidth = 900;
  resized();
  assert.equal(img().style.transform, "", "another size lets go of it, at once");
  // and a new revision drawn in the box takes it away with the rest
  view.clear();
  assert.equal(img(), null);
});

test("a picture in a markdown box is shown alone in the expanded box, and the words come back at their scroll", () => {
  const { view, body, words, shot, img, send, drawn } = zoomBox({ kind: "markdown" });
  body.scrollTop = 240;
  view.solo(shot);
  assert.ok(body.classList.contains("alone"), "the words hidden under it (.alone)");
  assert.equal(words.parent, body, "and kept where they are");
  const alone = img();
  assert.ok(alone && alone !== shot && alone.classList.contains("mbimg"), "a picture of its own, as an image box shows");
  assert.equal(alone.src, shot.src);
  assert.equal(alone.draggable, false);
  assert.equal(view.alone, alone);
  // it zooms as an image box's picture does
  view.expand(true);
  Object.assign(alone, { offsetWidth: 1000, offsetHeight: 600, offsetLeft: 0, offsetTop: 0, naturalWidth: 2000, naturalHeight: 1000 });
  send("wheel", { ctrlKey: true, deltaY: -60, clientX: 600, clientY: 300 });
  assert.ok(drawn().k > 1);
  // the box is still sized to the words under it, whatever stands over them
  const want = view.want({ width: 400, height: 800 });
  assert.equal(want.height, 700 + 2 + 30 + 8, "the words' height, the edges, the bar and the words' own white");
  assert.ok(body.classList.contains("alone"), "and the picture still stands alone after");
  // gone, the words come back at the scroll they had
  body.scrollTop = 0;
  view.solo(null);
  assert.ok(!body.classList.contains("alone"));
  assert.equal(img(), null);
  assert.equal(view.alone, null);
  assert.equal(body.scrollTop, 240);
  // an image box has no words to stand over
  const image = zoomBox();
  image.view.solo(image.img());
  assert.equal(image.view.alone, null);
  assert.ok(!image.body.classList.contains("alone"));
  // the sheet: alone it stands edge to edge with no fade, the words hidden, and expanded the body
  // cuts the picture, which wears no zoom cursor and moves from its top left corner
  const css = read("card-tokens.css");
  assert.match(css, /\.magicbox \.mbbody\.alone\{margin:0; -webkit-mask-image:none; mask-image:none\}/);
  assert.match(css, /\.magicbox \.mbbody\.alone > \.mbtext\{display:none\}/);
  assert.match(css, /\.magicbox:is\(\.big, \.moving\) \.mbbody:is\(\[data-kind="image"\], \.alone\)\{overflow:hidden\}/);
  assert.match(css, /\.magicbox \.mbimg\{transform-origin:0 0\}/);
  assert.match(css, /\.magicbox\.big \.mbimg\{cursor:default; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; -webkit-user-drag:none\}/);
  assert.match(css, /\.magicbox\.big \.mbimg\.zoomed\{cursor:grab\}/);
});

test("a picture clicked open in the box expands it through the page, a picture in the words shown alone; expanded it only shows it", () => {
  const asked = [];
  let can = true;
  const box = zoomBox({ kind: "markdown", hooks: { expand: back => { asked.push(back); if (can) box.view.expand(true); return can; } } });
  const { view, shot, body } = box;
  assert.equal(box.el._view, view, "the page guard finds the view on its box");
  assert.equal(view.picture(shot, "typing box"), true);
  assert.deepEqual(asked, ["typing box"], "the box expands, the focus to go back to what had it");
  assert.ok(body.classList.contains("alone") && view.alone);
  // expanded, another click shows it and asks for nothing
  assert.equal(view.picture(shot, null), true);
  assert.equal(asked.length, 1);
  // a box that cannot expand is left as it was
  const other = zoomBox({ kind: "markdown", hooks: { expand: () => false } });
  assert.equal(other.view.picture(other.shot, null), false);
  assert.ok(!other.body.classList.contains("alone") && !other.view.alone);
  // an image box's own picture expands it with nothing shown alone
  const image = zoomBox({ hooks: { expand: () => true } });
  assert.equal(image.view.picture(image.img(), null), true);
  assert.equal(image.view.alone, null);
  // with no way to expand, nothing
  assert.equal(zoomBox().view.picture(zoomBox().img(), null), false);
});

test("both pages hand the view their expand, say when the box is moving, and show the words again as it lands", () => {
  const html = read("index.html"), page = read("m.html");
  assert.match(html, /expand: from => \{ magicBig\(from\); return MB\.view\.big; \},\s*moving: \(\) => !!MB\.move,/);
  assert.match(page, /expand: from => \{ phoneMagicBig\(from\); return PB\.view\.big; \},\s*moving: \(\) => !!PB\.move \}\);/);
  // the Mac: the words come back as the box lands beside the card, or at once when it does not travel
  const { ctx, MB } = boardBig();
  const solos = [];
  MB.view.solo = img => solos.push(img);
  const anims = [];
  MB.el.animate = (keys, opts) => { const a = { keys, opts, cancel() {} }; anims.push(a); return a; };
  MB.line = { classList: { add() {}, remove() {} } };
  Object.assign(ctx, { cardPictureStill: () => false, getComputedStyle: () => MB.el.style,
    magicPlace: () => { if (MB.view.big) ctx.magicPlaceBig(); else Object.assign(MB.el.style, { left: "700px", top: "120px", width: "400px", height: "600px" }); } });
  Object.assign(MB.el.style, { left: "700px", top: "120px", width: "400px", height: "600px" });
  ctx.magicBig(null);
  anims.at(-1).onfinish();
  assert.deepEqual(solos, [], "expanded, a picture shown alone stays");
  ctx.magicSmall();
  assert.deepEqual(solos, [], "not at the press: the picture goes back with the box");
  anims.at(-1).onfinish();
  assert.deepEqual(solos, [null], "landed, the words");
  ctx.cardPictureStill = () => true;
  ctx.magicBig(null);
  ctx.magicSmall();
  assert.deepEqual(solos, [null, null], "with reduced motion at once");
  // the phone: the same as it lands in the drawer, and at once when the drawer or the box takes it back
  assert.match(page, /function phoneMagicLand\(\)\{[\s\S]*?\n  PB\.view\.solo\(null\);\n\}/);
  assert.match(page, /if \(glide\) phoneMagicMove\(was\);\s*if \(!PB\.move\) PB\.view\.solo\(null\);/);
  assert.match(html, /if \(!MB\.view\.big\) MB\.view\.solo\(null\);\s*magicPlace\(\);/);
});

// the board's expanded box, cut out of index.html and run on stand-ins: a
// stage at 0.8 shifted 20 across and 41 down, in a 1200 by 800 window
function boardBig() {
  const html = read("index.html");
  const src = html.slice(html.indexOf("function magicPlaceBig(){"), html.indexOf("// the card's rectangle on the stage, the fit's edges"));
  const calls = [], boxClasses = new Set(["on"]), bodyClasses = new Set(), inBox = new Set(), timers = [], listeners = {};
  const set = s => ({ add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)), contains: c => s.has(c) });
  const doc = { activeElement: null, body: { classList: set(bodyClasses) },
    getElementById: () => ({ getBoundingClientRect: () => ({ x: 20, y: 41 }) }) };
  doc.activeElement = doc.body;
  const field = name => ({ name, isConnected: true, focus() { doc.activeElement = this; calls.push("focus " + name); } });
  const MB = { el: { classList: set(boxClasses), style: {}, contains: x => inBox.has(x), animate() { calls.push("fade"); } },
    body: { querySelector: () => null }, shade: { style: {} }, came: null,
    view: { big: false, waiting: () => false, expand(on) { this.big = on; calls.push("expand " + on); }, solo() {} } };
  const ctx = vm.createContext({ MB, document: doc, stageScale: 0.8, innerWidth: 1200, innerHeight: 800, MagicBox: api(), window: {},
    magicPlace: () => { calls.push("place"); if (MB.view.big) ctx.magicPlaceBig(); }, magicRiseStop() {}, magicRiseSet() {},
    cardPictureStill: () => true, setTimeout: fn => timers.push(fn), clearTimeout() {}, queueFatCaret() {},
    keysBack: came => { came.ta.focus(); calls.push("caret back"); return true; },
    boardKeysLive: () => true, projOpen: () => false, searchOpen: false, p3Zoom: null, cardPictureShown: null, imeKey: () => false,
    ...pictureTime(), addEventListener: (type, fn) => { listeners[type] = fn; } });
  vm.runInContext(src, ctx);
  const escape = (more = {}) => { const e = { key: "Escape", repeat: false, defaultPrevented: false, taken: false,
    preventDefault() { e.defaultPrevented = true; }, stopImmediatePropagation() { e.taken = true; }, ...more };
    listeners.keydown(e); return e; };
  return { ctx, MB, doc, calls, bodyClasses, inBox, timers, field, escape };
}

test("on the Mac the expanded box and its shade are written in the stage's pixels: the box nine tenths of the window, the shade all of it", () => {
  const { ctx, MB } = boardBig();
  MB.view.big = true;
  ctx.magicPlaceBig();
  const px = v => parseFloat(v);
  // on the window: the stage's shift plus its scale times the stage's pixels
  const screen = s => ({ left: 20 + px(s.left) * .8, top: 41 + px(s.top) * .8, width: px(s.width) * .8, height: px(s.height) * .8 });
  const box = screen(MB.el.style), shade = screen(MB.shade.style);
  assert.ok(close(box.left, 60) && close(box.top, 40) && close(box.width, 1080) && close(box.height, 720), JSON.stringify(box));
  assert.ok(close(shade.left, 0) && close(shade.top, 0) && close(shade.width, 1200) && close(shade.height, 800), JSON.stringify(shade));
  assert.equal(MB.el.style.visibility, "");
  // the sheet: the shade is the settings page's dimming, over the whole window and the bar, under the box,
  // and the stage stands over the bar while it is up, under the project list, the search and the settings
  const html = read("index.html"), sheet = code(html.slice(0, html.indexOf("</style>")));
  assert.match(sheet, /body\.focus #mbshade\{[^}]*background-color:color-mix\(in srgb, var\(--ink\) 24%, transparent\); opacity:0;/);
  assert.match(sheet, /body\.focus\.mbbig #mbshade\{visibility:visible; pointer-events:auto; opacity:1;\s*transition:opacity \.3s cubic-bezier\(0\.25, 1, 0\.5, 1\), visibility 0s\}/);
  const z = sel => +sheet.match(new RegExp(sel + "\\{[^}]*z-index:(\\d+)"))[1];
  const stage = z("body\\.focus\\.mbup #stage");
  assert.ok(stage > z("\\n  \\.bar") && stage < z("body\\.focus #projshade") && stage < z("body\\.focus #searchshade"), "between the bar and the menus");
  assert.ok(z("body\\.focus #magicbox\\.big\\.on") > z("body\\.focus #mbshade"), "the box over its shade");
  assert.ok(html.indexOf('<div id="mbshade"') > html.indexOf('<div id="stage">') && html.indexOf('<div id="mbshade"') < html.indexOf('<section id="magicbox"'),
    "the shade stands in the stage, under the box");
});

test("on the Mac the button expands the box and Escape puts it back, the focus back where it was", () => {
  const { ctx, MB, doc, calls, bodyClasses, inBox, timers, field, escape } = boardBig();
  const typing = field("typing box"), button = field("button");
  inBox.add(button);
  ctx.magicBig(typing);
  assert.equal(MB.view.big, true);
  assert.ok(bodyClasses.has("mbbig") && bodyClasses.has("mbup"), "the shade up and the stage over the bar");
  doc.activeElement = button;   // the press put the focus on the button
  const e = escape();
  assert.ok(e.defaultPrevented && e.taken, "Escape is the box's, ahead of the board's own");
  assert.equal(MB.view.big, false);
  assert.ok(!bodyClasses.has("mbbig") && bodyClasses.has("mbup"), "the shade fades out with the stage still over the bar");
  timers.splice(0).forEach(f => f());
  assert.ok(!bodyClasses.has("mbup"), "and the stage goes back under it once the shade has faded");
  assert.equal(doc.activeElement, typing, "the focus is back in the typing box");
  // the typing box's caret and selection as they were, when the box remembered them
  MB.came = { ta: typing };
  ctx.magicBig(typing); doc.activeElement = button; ctx.magicSmall();
  // and before the box sets off (here the quick fade of reduced motion), so the keys are where they
  // will be as it lands, and it eases toward that strength, faint or not, from its first frame
  assert.deepEqual(calls.slice(-4), ["place", "focus typing box", "caret back", "fade"]);
  // the owner's focus put somewhere else on the board meanwhile stays there
  const other = field("title");
  ctx.magicBig(typing); doc.activeElement = other; ctx.magicSmall();
  assert.equal(doc.activeElement, other);
  // something over the box that holds the keys keeps Escape for itself
  ctx.magicBig(null);
  ctx.searchOpen = true;
  assert.equal(escape().taken, false);
  assert.equal(MB.view.big, true);
  ctx.searchOpen = false;
  assert.equal(escape({ defaultPrevented: true }).taken, false, "an Escape something on the board already answered");
  assert.equal(MB.view.big, true);
  escape();
  assert.equal(MB.view.big, false);
  // the wiring: the button both ways, the shade, a page's Escape, the box going, and the same card's next revision
  const html = read("index.html");
  assert.match(html, /MB\.grow\.addEventListener\("click", e => \{[\s\S]*?if \(MB\.view\.big\) magicSmall\(\);\s*else magicBig\(from\);/);
  assert.match(html, /MB\.shade\.addEventListener\("click", \(\) => magicSmall\(\)\);/);
  assert.match(html, /escape: \(\) => magicEscape\(\),/);
  assert.match(html, /if \(MB\.view\.big\)\{ magicPlaceBig\(\); return; \}/);
});

test("on the Mac a box that held the keys as it was expanded still holds them as it goes back, and one that did not lets them go", () => {
  const { ctx, MB, doc, calls, inBox, field, escape } = boardBig();
  const typing = field("typing box"), frame = field("page");
  inBox.add(frame);
  frame.blur = () => { doc.activeElement = doc.body; calls.push("blur page"); };
  ctx.magicHold = inside => { MB.el.classList[inside ? "add" : "remove"]("held"); calls.push("hold " + inside); };
  const held = () => MB.el.classList.contains("held");
  // held as it was expanded (a click in it, or control+option+right): the keys stay in the box as it
  // goes back by the button, Escape or the dimmed board (all magicSmall), even with the typing box
  // read as what had the focus when it was asked for
  MB.el.classList.add("held");
  for (const from of [null, typing]) {
    ctx.magicBig(from);
    calls.length = 0;
    escape();
    assert.equal(MB.view.big, false);
    assert.ok(held() && doc.activeElement === doc.body, "the box holds the keys");
    assert.ok(!calls.some(c => /^(focus|hold|caret|blur)/.test(c)), calls.join(", "));
  }
  // a page in it that had them keeps them
  ctx.magicBig(frame); doc.activeElement = frame; ctx.magicSmall();
  assert.ok(held() && doc.activeElement === frame);
  // given back to the card while it was expanded (control+option+left), they stay there
  ctx.magicBig(null); MB.el.classList.remove("held"); doc.activeElement = typing; ctx.magicSmall();
  assert.ok(!held() && doc.activeElement === typing);
  // not held as it was expanded, then clicked into: the keys go back to the typing box and the box lets go
  ctx.magicBig(typing); MB.el.classList.add("held"); doc.activeElement = doc.body; ctx.magicSmall();
  assert.ok(!held() && doc.activeElement === typing);
  // and with nothing to go back to, whatever in the box took them lets go too
  ctx.magicBig(null); MB.el.classList.add("held"); doc.activeElement = frame; ctx.magicSmall();
  assert.ok(!held() && doc.activeElement === doc.body, "the page in it lets go");
  // the press on the dimmed board that puts it back leaves the box held or not as it was, as one on
  // the cross or the green button does, and like them it takes the focus from nothing
  const html = read("index.html"), on = {}, classes = new Set(["on"]);
  const el = { contains: () => false, classList: { contains: c => classes.has(c), toggle: (c, yes) => (yes ? classes.add(c) : classes.delete(c)) } };
  vm.runInContext(html.slice(html.indexOf("function magicHold("), html.indexOf('addEventListener("focusin"')),
    vm.createContext({ MB: { el, came: null }, addEventListener: (type, fn) => { on[type] = fn; } }));
  const shade = { closest: sel => (sel === "#mbshade" ? shade : null) }, board = { closest: () => null };
  classes.add("held"); on.pointerdown({ target: shade });
  assert.equal(classes.has("held"), true, "held");
  on.pointerdown({ target: board });
  assert.equal(classes.has("held"), false, "a press anywhere else on the board still takes the keys");
  on.pointerdown({ target: shade });
  assert.equal(classes.has("held"), false, "not held");
  assert.match(html, /for \(const b of \[MB\.el\.querySelector\("\.mbclose"\), MB\.grow, MB\.shade\]\) b\.addEventListener\("mousedown", e => e\.preventDefault\(\)\);/);
  assert.match(html, /MB\.bigFrom = from && from !== document\.body \? from : null;\s*MB\.bigHeld = MB\.el\.classList\.contains\("held"\);/);
});

test("on the Mac the block caret of a field under the expanded box is not drawn over it, and is drawn again once the box is down", () => {
  // the caret is laid again as the box goes up, and once its shade has gone
  const { ctx, bodyClasses, timers } = boardBig();
  const laid = [];
  ctx.queueFatCaret = () => laid.push([...bodyClasses].sort().join(" "));
  ctx.magicBig(null);
  assert.deepEqual(laid, ["mbbig mbup"], "as the box goes up");
  ctx.magicSmall();
  assert.equal(laid.length, 1, "not as it sets off back, with its shade still up");
  timers.splice(0).forEach(f => f());
  assert.deepEqual(laid, ["mbbig mbup", ""], "and once the shade has gone");
  // the caret's own rule, run on stand-ins: while the box is up, a field on the
  // stage outside the box is under it, and one over the stage or in the box is not
  const html = read("index.html");
  const rule = html.match(/\n  const underBox = el => [\s\S]*?;\n/);
  assert.ok(rule, "the rule is in the caret's block");
  const classes = new Set(), stage = {}, inBox = new Set();
  const field = onStage => ({ closest: sel => (sel === "#stage" && onStage ? stage : null) });
  const scope = vm.createContext({ document: { body: { classList: { contains: c => classes.has(c) } } },
    MB: { el: { contains: x => inBox.has(x) } } });
  vm.runInContext(rule[0].replace("const underBox", "var underBox"), scope);
  const title = field(true), typing = field(true), search = field(false), page = field(true);
  inBox.add(page);
  const under = () => [title, typing, search, page].map(f => scope.underBox(f));
  assert.deepEqual(under(), [false, false, false, false], "the box down");
  classes.add("mbup");
  assert.deepEqual(under(), [true, true, false, false], "the box up: the title and the typing box under it");
  // and the caret is put out for such a field before anything else is measured
  assert.match(html, /if \(!cur \|\| !cur\.isConnected\)\{ cur = null; hide\(\); return; \}\n    if \(underBox\(cur\)\)\{ hide\(\); return; \}/);
});

test("on the phone the button lifts the box into the top layer over a shade, inside the safe areas, and the drawer puts it back first", () => {
  const { ctx, PB, box, body, listeners } = phoneBoxScript(read("m.html"));
  const order = [];
  const popover = (el, name) => Object.assign(el, { attrs: {}, up: false,
    setAttribute(k, v) { el.attrs[k] = v; }, removeAttribute(k) { delete el.attrs[k]; },
    showPopover() { el.up = true; order.push(name + " up"); }, hidePopover() { el.up = false; order.push(name + " down"); },
    matches: s => s === ":popover-open" && el.up, getAnimations: () => [], animate() {} });
  popover(box, "box");
  let shade = null;
  ctx.document.createElement = () => {
    const el = popover({ style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 47, width: 402, height: 874 - 47 - 34 }) }, "shade");
    if (!shade) shade = el;
    return el;
  };
  const timers = [];
  Object.assign(ctx, { innerHeight: 874, window: {}, cardPictureStill: () => true, cardPictureShown: null, imeKey: () => false,
    clearTimeout() {}, setTimeout: fn => timers.push(fn) });
  const { BIG, grow } = api();
  Object.assign(ctx.MagicBox, { BIG, grow });
  Object.assign(PB.view, { big: false, expand(on) { this.big = !!on; } });
  body.querySelector = s => s === ".mbaway" ? null : { getBoundingClientRect: () => ({ bottom: 81 }), style: { paddingBottom: "16px" } };
  ctx.phoneMagicBig(null);
  assert.equal(PB.view.big, true);
  assert.deepEqual(order, ["shade up", "box up"], "the shade goes up first, under the box");
  assert.equal(box.attrs.popover, "manual");
  const px = v => parseFloat(v);
  assert.ok(close(px(box.style.width), 402 * .95) && close(px(box.style.left), 402 * .025), "95% of the screen across");
  assert.equal(px(box.style.top), 47, "under the notch");
  assert.equal(px(box.style.top) + px(box.style.height), 874 - 34, "over the home bar");
  // the drawer under the shade keeps the foot the box had in it
  box.offsetHeight = 793;
  assert.equal(ctx.phoneMagicFoot(), 89);
  // every press on the box is its own while it is expanded: no pull of the drawer starts
  let stopped = 0;
  for (const fn of box.on.touchstart) fn({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 1);
  // Escape, heard first, puts it back in the drawer, with reduced motion at once, and the shade
  // goes once it has faded
  const esc = listeners.keydown.find(l => l.opts === true);
  const e = { key: "Escape", repeat: false, defaultPrevented: false, taken: false,
    preventDefault() { e.defaultPrevented = true; }, stopImmediatePropagation() { e.taken = true; } };
  esc.fn(e);
  assert.ok(e.taken && e.defaultPrevented);
  assert.equal(PB.view.big, false);
  assert.equal(box.up, false);
  assert.equal(box.attrs.popover, undefined);
  assert.equal(box.style.left, "");
  timers.splice(0).forEach(f => f());
  assert.equal(shade.up, false);
  for (const fn of box.on.touchstart) fn({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 1, "back in the drawer, its presses are the drawer's as they always were");
  // the drawer setting out to go back, by any of its ways, and its keys, put the box back first
  ctx.phoneMagicBig(null);
  ctx.runMenu(ctx.tickets, 0);
  assert.equal(PB.view.big, false);
  ctx.phoneMagicBig(null);
  ctx.runMenu(ctx.tickets, 1);
  assert.equal(PB.view.big, true, "the drawer coming out leaves it");
  vm.runInContext("drawerKey(null, true)", ctx);
  assert.equal(PB.view.big, false);
  // and the box going, or another card's
  ctx.phoneMagicBig(null);
  vm.runInContext("phoneMagicOff()", ctx);
  assert.equal(PB.view.big, false);
});

test("on the Mac the box zooms out of its place beside the card and back into it as a picture does, its own rectangle eased in step with the shade", () => {
  const { ctx, MB } = boardBig();
  const html = read("index.html"), sheet = code(html.slice(0, html.indexOf("</style>")));
  const anims = [], lines = new Set(["on"]);
  MB.line = { classList: { add: c => lines.add(c), remove: c => lines.delete(c) } };
  MB.el.animate = (keys, opts) => { const a = { keys: flat(keys), opts: flat(opts), cancelled: false, playState: "running", currentTime: 0,
    cancel() { a.cancelled = true; a.playState = "idle"; } }; anims.push(a); return a; };
  // where the box is drawn: its own place, or wherever a move has got to
  let drawn = null;
  const small = { left: "700px", top: "120px", width: "400px", height: "600px" };
  const rect = s => ({ left: s.left, top: s.top, width: s.width, height: s.height });
  Object.assign(ctx, { cardPictureStill: () => false, getComputedStyle: () => drawn || MB.el.style,
    magicPlace: () => { if (MB.view.big) ctx.magicPlaceBig(); else Object.assign(MB.el.style, small); } });
  // a faint box beside the card: the keys are in the card
  Object.assign(MB.el.style, small, { opacity: "0.6" });
  ctx.magicBig(null);
  const big = rect(MB.el.style);
  // and at the strength it was drawn at, which the move eases up to the expanded box's own
  assert.deepEqual(anims[0].keys, [{ ...small, opacity: "0.6" }, big], "from its place beside the card to the expanded one");
  // the time and curve a card's picture zooms out of its card on (openCardPicture)
  assert.deepEqual(anims[0].opts, { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  assert.ok(MB.move === anims[0] && MB.el.classList.contains("moving"));
  // landed, it is placed as it always is
  anims[0].onfinish();
  assert.ok(!MB.move && !MB.el.classList.contains("moving"));
  // and back into its place, over the shade until it lands, its lines to the card drawn once it has.
  // it sets off at the expanded box's full strength, and its last frame holds none: it ends on the
  // strength its own rules give it there, faint or not, so nothing is left to fade once it lands
  MB.el.style.opacity = "1";
  ctx.magicSmall();
  assert.deepEqual(anims[1].keys, [{ ...big, opacity: "1" }, small]);
  assert.ok(!("opacity" in anims[1].keys[1]) && !("opacity" in anims[0].keys[1]), "the last frame leaves the strength to the box's own rules");
  assert.deepEqual(anims[1].opts, { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  assert.ok(MB.el.classList.contains("moving") && !lines.has("on"));
  // turned round on its way, it sets off again from where it had got to, at the strength it had
  // got to, in the time it had spent, as the picture does, and never in less than .4 of the whole
  drawn = { left: "500px", top: "100px", width: "800px", height: "700px", opacity: "0.8" };
  anims[1].currentTime = 150;
  ctx.magicBig(null);
  assert.ok(anims[1].cancelled);
  assert.deepEqual(anims[2].keys, [drawn, big]);
  assert.equal(anims[2].opts.duration, 150);
  anims[2].currentTime = 30;
  ctx.magicSmall();
  assert.equal(anims[3].opts.duration, 120);
  ctx.magicBig(null);
  drawn = null;
  anims[4].onfinish();
  // with reduced motion it does not travel: it fades in where it now stands, quickly
  ctx.cardPictureStill = () => true;
  ctx.magicSmall();
  assert.deepEqual(anims[5].keys, [{ opacity: 0, offset: 0 }]);
  assert.deepEqual(anims[5].opts, { duration: 160, easing: "ease" });
  assert.ok(!MB.move && !MB.el.classList.contains("moving"));
  // nothing places it on its way, and the box going stops it where it is
  assert.match(html, /function magicPlace\(\)\{\s*if \(!MB\.el \|\| !MB\.el\.classList\.contains\("on"\)\) return;\s*if \(MB\.move\) return;/);
  assert.match(html, /magicRiseSet\(1\);\s*if \(!keep\) magicMoveStop\(\);/);
  // the shade fades on the same time and curve, quickly with reduced motion, and the box on its way stands over it
  assert.match(html, /const BIG_MS = CARD_PICTURE_MS, BIG_EASE = CARD_PICTURE_EASE, BIG_FADE_MS = 160;/);
  // by its strength, never its colour, which now and then showed the colour it set off from for one frame as it ended
  assert.match(sheet, /body\.focus #mbshade\{[^}]*transition:opacity \.3s cubic-bezier\(0\.25, 1, 0\.5, 1\), visibility 0s linear \.3s\}/);
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\)\{\s*body\.focus #mbshade\{transition:opacity \.16s ease, visibility 0s linear \.16s !important\}/);
  assert.doesNotMatch(sheet.slice(sheet.indexOf("#mbshade{display:none}"), sheet.indexOf("body.focus.mbup #stage")), /transition:background-color/);
  const z = sel => +sheet.match(new RegExp(sel + "\\{[^}]*z-index:(\\d+)"))[1];
  assert.ok(z("body\\.focus #magicbox\\.moving\\.on") > z("body\\.focus #mbshade"), "on its way back the box stays over the shade");
  // on its way no rule gives it a strength, so the move's is the one drawn, and the box's own .2s
  // fade is off, so it never fades on its own as it lands; expanded it is whole, beside the card
  // whole if held and faint if not
  assert.equal(sheet.match(/\n  body\.focus #magicbox\.moving\.on\{([^}]*)\}/)[1], "z-index:61; transition:box-shadow .2s");
  assert.match(sheet, /\n  body\.focus #magicbox\.big\.on\{z-index:61; opacity:1; box-shadow:var\(--shade-raised\)\}/);
  assert.match(sheet, /\n  :is\(#magicbox, #pipebox\)\.held\{box-shadow:var\(--shade-raised\); opacity:1\}/);
  assert.match(sheet, /\n  :is\(#magicbox, #pipebox\)\{[^}]*opacity:var\(--shade-unselected\); transition:box-shadow \.2s, opacity \.2s\}/);
  // a small picture shrinks with the box from where it stood
  assert.match(read("card-tokens.css"), /\.magicbox:is\(\.big, \.moving\) \.mbimg\{object-fit:scale-down\}/);
});

test("on the Mac the keys moving while the box is on its way take it to its new strength from where it is, over the box's own .2s", () => {
  const html = read("index.html");
  const src = html.slice(html.indexOf("function magicHold("), html.indexOf("// where the owner is on the card as the box takes the keys"));
  const classes = new Set(["on"]), anims = [];
  const MB = { el: { classList: { contains: c => classes.has(c), toggle: (c, yes) => (yes ? classes.add(c) : classes.delete(c)) },
    animate: (keys, opts) => anims.push({ keys: flat(keys), opts: flat(opts) }) }, move: null, came: null };
  // the strength the move draws: faint while the keys are in the card, whole once the box holds them
  const ctx = vm.createContext({ MB, getComputedStyle: () => ({ opacity: classes.has("held") ? "0.95" : "0.72" }) });
  vm.runInContext(src, ctx);
  // standing beside the card the class is all there is, which the box's own .2s fade eases
  ctx.magicHold(true); ctx.magicHold(false);
  assert.equal(anims.length, 0);
  // on its way, from the strength it is drawn at as the keys move, to the one the move now gives it
  MB.move = {};
  ctx.magicHold(true);
  assert.equal(classes.has("held"), true);
  assert.deepEqual(anims, [{ keys: [{ opacity: "0.72" }, {}], opts: { duration: 200, easing: "ease" } }]);
  // the keys staying where they are change nothing
  ctx.magicHold(true);
  assert.equal(anims.length, 1);
  ctx.magicHold(false);
  assert.deepEqual(anims[1].keys, [{ opacity: "0.95" }, {}]);
  assert.equal(classes.has("held"), false);
});

test("on the phone the box zooms out of its place in the drawer and back into it as a picture does, in the top layer both ways", () => {
  const { ctx, PB, box, body, anims } = phoneBoxScript(read("m.html"));
  const boxClasses = new Set(), timers = [];
  const popover = el => Object.assign(el, { attrs: {}, up: false,
    setAttribute(k, v) { el.attrs[k] = v; }, removeAttribute(k) { delete el.attrs[k]; },
    showPopover() { el.up = true; }, hidePopover() { el.up = false; }, matches: s => s === ":popover-open" && el.up });
  popover(box);
  box.classList = { add: c => boxClasses.add(c), remove: c => boxClasses.delete(c), contains: c => boxClasses.has(c) };
  // in the drawer the box stands where the drawer lays it out; up in the top layer, where its style puts it
  const px = v => parseFloat(v);
  let mid = null;
  box.getBoundingClientRect = () => {
    const s = box.style;
    if (box.up && mid) return mid;
    return box.up ? { left: px(s.left), top: px(s.top), width: px(s.width), height: px(s.height) }
      : { left: 28, top: 140, width: px(s.width), height: px(s.height) };
  };
  ctx.document.createElement = () => popover({ style: {}, addEventListener() {}, getAnimations: () => [], animate() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 402, height: 874 }) });
  Object.assign(ctx, { innerHeight: 874, window: {}, cardPictureStill: () => false, cardPictureShown: null, imeKey: () => false,
    clearTimeout() {}, setTimeout: fn => timers.push(fn) });
  const { BIG, grow } = api();
  Object.assign(ctx.MagicBox, { BIG, grow });
  Object.assign(PB.view, { big: false, expand(on) { this.big = !!on; } });
  body.querySelector = s => s === ".mbaway" ? null : { getBoundingClientRect: () => ({ bottom: 81 }), style: { paddingBottom: "16px" } };
  const moves = () => anims.filter(a => a.part === "box");
  const keys = i => flat(moves()[i].keys), opts = i => flat(moves()[i].opts);
  const rect = s => ({ left: s.left, top: s.top, width: s.width, height: s.height });
  ctx.phoneMagicFit();
  const inDrawer = { left: "28px", top: "140px", width: box.style.width, height: box.style.height };
  ctx.phoneMagicBig(null);
  const big = rect(box.style);
  assert.deepEqual(keys(0), [inDrawer, big], "out of its place in the drawer to 95% of the screen");
  assert.deepEqual(opts(0), { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  assert.ok(box.up && PB.move === moves()[0]);
  moves()[0].onfinish();
  assert.ok(!PB.move);
  // back: lifted over the shade again where it stands in the drawer, and carried there
  ctx.phoneMagicSmall(true);
  assert.deepEqual(keys(1), [big, inDrawer], "from the expanded place back into its own in the drawer");
  assert.deepEqual(opts(1), { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  assert.ok(box.up && box.attrs.popover === "manual" && boxClasses.has("moving"), "up over the shade on its way");
  // the drawer keeps the foot the box lands with, whatever the moving box measures
  box.offsetHeight = 400;
  assert.equal(ctx.phoneMagicFoot(), 89);
  box.offsetHeight = 89;
  moves()[1].onfinish();
  assert.ok(!box.up && box.attrs.popover === undefined && !boxClasses.has("moving") && box.style.left === "", "landed in the drawer");
  // turned round on its way back, it lands and sets off again from where it had got to, in the
  // time it had spent, as the picture does
  ctx.phoneMagicBig(null);
  moves()[2].onfinish();
  ctx.phoneMagicSmall(true);
  mid = { left: 20, top: 80, width: 360, height: 500 };
  Object.assign(moves()[3], { playState: "running", currentTime: 150 });
  ctx.phoneMagicBig(null);
  mid = null;
  assert.ok(moves()[3].cancelled);
  assert.deepEqual(keys(4), [{ left: "20px", top: "80px", width: "360px", height: "500px" }, big]);
  assert.equal(opts(4).duration, 150);
  moves()[4].onfinish();
  // the drawer setting out to go back lands a box still on its way at once
  ctx.phoneMagicSmall(true);
  ctx.runMenu(ctx.tickets, 0);
  assert.ok(moves()[5].cancelled && !PB.move && !box.up && !boxClasses.has("moving"));
  // with reduced motion it does not travel: it fades in where it now stands, quickly
  ctx.cardPictureStill = () => true;
  ctx.phoneMagicBig(null);
  assert.deepEqual(keys(6), [{ opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual(opts(6), { duration: 160, easing: "ease" });
  // the button, Escape and the shade glide it back; the drawer, its keys and the box going put it back at once
  const page = read("m.html");
  assert.match(page, /escape: \(\) => \{ if \(!cardPictureShown\) phoneMagicSmall\(true\); \},/);
  assert.match(page, /if \(PB\.view\.big\) phoneMagicSmall\(true\);\s*else phoneMagicBig\(from\);/);
  assert.match(page, /shade\.addEventListener\("click", \(\) => phoneMagicSmall\(true\)\);/);
  assert.match(page, /if \(!e\.repeat\) phoneMagicSmall\(true\);/);
  assert.match(page, /function phoneMagicOff\(\)\{\s*phoneMagicSmall\(\);/);
  assert.match(code(page), /#mbface:is\(\.big, \.moving\)\{position:fixed; inset:auto; margin:0;/);
  // the picture's own time and curve, and the shade fades on the move's
  assert.match(page, /const PB_BIG_MS = CARD_PICTURE_MS, PB_BIG_EASE = CARD_PICTURE_EASE, PB_FADE_MS = 160;/);
  assert.match(page, /shade\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], phoneMagicTime\(was \? was\.part : 1\)\);/);
});

test("the genie is gone from both pages: no canvas, no pictures of the box, no strips", () => {
  const pages = ["index.html", "m.html", "card-logic.js", "magic-box.js", "card-tokens.css"].map(read).join("\n");
  assert.doesNotMatch(pages, /genie|magicLook|mbgenie|webgl/i);
  assert.equal(api().genie, undefined);
});
