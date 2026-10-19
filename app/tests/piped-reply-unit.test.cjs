// A long reply on the Mac board: the typing row grows to the sheet's cap, its
// first step, and past that stands at once at its second, as tall as leaves the
// response's first two lines whole above the answer's fade, read off the card as
// it is laid out, whatever the card's height, its title, the bubbles over the
// response or the stage's scale. At the second step the response is piped out
// beside the card, where the magic box stands (MagicBox.place, either side of
// the card), on the right unless the card's box stands there or the right has no
// room, and tied to the card by a square dashed brace whose lower part stretches
// with it. Control + Option toward it puts the keys in it and away brings them
// back, and up and down treat it as the card's response. The phone page keeps
// one step and pipes nothing. Run from the pages' own source, no browser: the
// functions are cut out of index.html as written.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = read("index.html");
function cut(from, to) {
  const a = HTML.indexOf(from), b = HTML.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} ... ${to}`);
  return HTML.slice(a, b);
}
const fn = name => cut(`function ${name}(`, "\n}\n") + "\n}\n";
const box = () => {
  const scope = vm.createContext({});
  vm.runInContext(read("magic-box.js"), scope);
  return scope.MagicBox;
};
const MagicBox = box();
const close = (a, b, by = 1e-6) => Math.abs(a - b) < by;

// ---- where it stands -----------------------------------------------------------
// the card where a new board puts it, in stage pixels, and the workspace in a
// window w wide (as the magic box tests have them), with its left edge too
const CARD = { left: 1440 * 0.324, top: 900 * 0.0576, width: 1440 * 0.352, height: 900 * 0.8448 };
const fitAt = (w, more = {}) => ({ scale: 1, tx: Math.max(0, (w - 1440) / 2), right: w - 6.5, left: 6.5, clear: 16, ...more });

test("left of the card the box stands as it does on the right, turned over", () => {
  for (const w of [1280, 1440, 1512, 1728, 2200]) {
    const fit = fitAt(w);
    const right = MagicBox.place(CARD, fit), left = MagicBox.place(CARD, fit, null, "left");
    // sized from the card's height and its own room, level with the card's middle
    const middle = CARD.top + CARD.height / 2;
    assert.ok(close(left.top + left.height / 2, middle) && close(right.top + right.height / 2, middle), `level at ${w}`);
    assert.ok(left.height <= MagicBox.TALL * CARD.height + 1e-6, `no taller than the box at ${w}`);
    const roomLeft = CARD.left - (fit.left - fit.tx) / fit.scale;
    assert.ok(left.width <= roomLeft - 2 * fit.clear + 1e-6, `inside its room at ${w}`);
    // never over the card, and at full size held as near it as the right one is
    const gap = CARD.left - (left.left + left.width);
    assert.ok(gap >= fit.clear - 1e-6, `gap ${gap} at ${w}`);
    if (fit.scale >= 1 && left.width === right.width) {
      const gapRight = right.left - (CARD.left + CARD.width);
      assert.ok(gap <= Math.max(gapRight, MagicBox.GAP * CARD.width) + 1e-6, `held near the card at ${w}`);
    }
  }
  // what the box shows takes its own height the same either side
  const fit = fitAt(1512);
  const words = { height: 300 };
  const l = MagicBox.place(CARD, fit, words, "left"), r = MagicBox.place(CARD, fit, words);
  assert.ok(close(l.height, 300) && close(r.height, 300) && close(l.top, r.top), "hung from the largest box's top");
  // a left with no room is not shown, as a right with none is not
  assert.equal(MagicBox.place({ ...CARD, left: 200 }, fit, null, "left").shown, false);
  // and the right is as it always was without a side
  assert.deepEqual({ ...MagicBox.place(CARD, fit) }, { ...MagicBox.place(CARD, fit, undefined, "right") });
});

// ---- the response's first lines ---------------------------------------------------
// a response laid out as rows of words, each row a run of text fragments with its
// own rectangle, read as the browser's ranges read them
function laidOut(rows, extra = []) {
  const texts = [];
  rows.forEach(fragments => fragments.forEach(r => texts.push({ data: "words", parentElement: { closest: () => null },
    rects: [{ top: r[0], bottom: r[1], height: r[1] - r[0], width: 50 }] })));
  for (const t of extra) texts.push(t);
  texts.sort((a, b) => (a.rects[0] ? a.rects[0].top : 0) - (b.rects[0] ? b.rects[0].top : 0));
  return { texts, top: rows.length ? rows[0][0][0] : 0 };
}
function domFor(context) {
  context.NodeFilter = { SHOW_TEXT: 4 };
  context.document = {
    createTreeWalker: reply => { let i = -1; return { nextNode: () => reply.texts[++i] || null }; },
    createRange: () => ({ selectNodeContents(t) { this.t = t; }, getClientRects() { return this.t.rects; } }),
  };
  return context;
}
const lines = vm.createContext(domFor({}));
vm.runInContext(fn("pipeLines"), lines);

test("the foot of the response's first two lines is read off its words as laid out", () => {
  const two = laidOut([[[100, 123]], [[128, 151]], [[156, 179]]]);
  assert.equal(lines.pipeLines(two, 2), 151);
  // words split over several runs of one line (a link, bold) are one line, the tallest run's foot
  const runs = laidOut([[[100, 123], [99, 124]], [[128, 151], [127.5, 153]], [[156, 179]]]);
  assert.equal(lines.pipeLines(runs, 2), 153);
  // a heading over the words: its own line height, whatever it is
  const heading = laidOut([[[100, 132]], [[140, 163]], [[168, 191]]]);
  assert.equal(lines.pipeLines(heading, 2), 163);
  // one line has that one, none has nothing, and spaces between blocks are not words
  assert.equal(lines.pipeLines(laidOut([[[100, 123]]]), 2), 123);
  assert.equal(lines.pipeLines(laidOut([]), 2), null);
  const spaced = laidOut([[[100, 123]], [[128, 151]]], [{ data: "\n  ", parentElement: { closest: () => null }, rects: [{ top: 90, bottom: 95, height: 5 }] }]);
  assert.equal(lines.pipeLines(spaced, 2), 151);
  // a code block's copy button is not the response's words
  const button = { data: "Copy", parentElement: { closest: sel => (sel === "button" ? {} : null) }, rects: [{ top: 60, bottom: 75, height: 15 }] };
  assert.equal(lines.pipeLines(laidOut([[[100, 123]], [[128, 151]]], [button]), 2), 151);
});

// ---- the two steps --------------------------------------------------------------------
// a card laid out on a stage drawn at scale S, everything in stage pixels and
// read in the screen's: the head (title and top bar) over the answer, the
// answered bubbles at the answer's head, then the response's lines, and at the
// foot the row under its hairline. the row stands at the height it was set to,
// under the cap in force: the sheet's first step, or --pipe-tall once piped
const FADE = 22;
function cardAt({ S = 1, top = 52, height = 760, head = 110, answ = 80, count = 12, line = 27.9, glyph = 23,
  first = 252, air = 3.5 } = {}) {
  const m = { scroll: 0, text: "typed words" };
  const classes = new Set(["sel"]), boxStyle = {};
  const row = { style: { height: "44px" } };
  const piped = () => classes.has("piped");
  const cap = () => (piped() ? parseFloat(boxStyle["--pipe-tall"]) : first);
  const rendered = () => Math.min(parseFloat(row.style.height) || 44, cap());
  const viewTop = top + head, foot = top + height - 22;
  const scr = v => v * S;
  const reply = { get texts() {
    return Array.from({ length: count }, (_, i) => {
      const at = viewTop + answ + i * line + (line - glyph) / 2 - m.scroll;
      return { data: "words", parentElement: { closest: () => null }, rects: [{ top: scr(at), bottom: scr(at + glyph), height: scr(glyph) }] };
    });
  }, getBoundingClientRect: () => ({ top: scr(viewTop + answ - m.scroll) }), textContent: count ? "words" : "" };
  row.getBoundingClientRect = () => ({ height: scr(rendered()) });
  const view = { get scrollTop() { return m.scroll; }, set scrollTop(v) { m.scroll = v; } };
  const el = {
    box: { classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
      style: { setProperty: (k, v) => { boxStyle[k] = v; }, getPropertyValue: k => boxStyle[k] || "" } },
    replyview: view, reply, ta: row,
    pendwrap: { getBoundingClientRect: () => ({ top: scr(foot - 1 - rendered()) }) },
    field: { view: null, text: () => m.text },
  };
  // the second line's foot with the answer at its head, and what the fade needs under it
  const secondFoot = count >= 2 ? viewTop + answ + line + (line - glyph) / 2 + glyph
    : count === 1 ? viewTop + answ + (line - glyph) / 2 + glyph : viewTop + answ;
  return { el, row, m, classes, boxStyle, S, first, air, rendered, pendTop: () => foot - 1 - rendered(), secondFoot };
}
function stepper(card) {
  const synced = [];
  const context = vm.createContext(domFor({
    els: { c1: card.el }, shownId: "c1", stageScale: card.S, pipeSync: () => synced.push(1),
    getComputedStyle: node => node === card.row ? { maxHeight: card.first + "px" }
      : node === card.el.replyview ? { marginBottom: card.air + "px" }
      : { getPropertyValue: k => (k === "--replyfade" ? FADE + "px" : "") },
  }));
  vm.runInContext(fn("pipeStep") + fn("pipeTall") + fn("pipeLines"), context);
  // the row's tick: set to its words' own height, then the steps
  const type = words => { card.row.style.height = words + "px"; context.pipeStep("c1"); };
  return { context, type, synced };
}

test("the row grows to the first step, then stands at the second at once", () => {
  const card = cardAt();
  const { type, synced } = stepper(card);
  for (const words of [44, 95, 146, 197, 248, 252]) {
    type(words);
    assert.equal(card.classes.has("piped"), false, `${words} is under the first step`);
    assert.equal(card.rendered(), words, "a line at a time");
  }
  type(260);
  assert.equal(card.classes.has("piped"), true, "past the first step");
  const tall = parseFloat(card.boxStyle["--pipe-tall"]);
  assert.ok(tall > card.first + 100, `a step well over the first: ${tall}`);
  assert.equal(card.rendered(), tall, "the whole second step at once, not the words' height");
  type(300); type(1200);
  assert.equal(card.rendered(), tall, "and it holds there as the reply runs on, scrolling inside");
  type(240);
  assert.equal(card.classes.has("piped"), false, "cut back under the first step");
  assert.equal(card.rendered(), 240);
  assert.ok(synced.length > 0, "the card on screen pipes its response or takes it back each time");
});

test("the second step leaves the response's first two lines whole, at every card height, title, bubble and scale", () => {
  let seen = 0;
  for (const S of [1, 0.8, 0.62])
    for (const height of [520, 640, 760, 860])
      for (const head of [80, 140])
        for (const answ of [0, 80, 160])
          for (const air of [3.5, 25.05]) {
            const card = cardAt({ S, height, head, answ, air });
            const { type } = stepper(card);
            type(600);
            const tall = parseFloat(card.boxStyle["--pipe-tall"]);
            const name = JSON.stringify({ S, height, head, answ, air });
            assert.ok(tall >= card.first, name + " never under the first step");
            if (tall > card.first) {
              // the row's top: the second line's foot, the fade and the clear air over it, to a pixel
              const gap = card.pendTop() - (card.secondFoot + FADE + air);
              assert.ok(Math.abs(gap) <= 1, `${name}: ${gap}`);
              seen++;
            } else {
              assert.ok(card.secondFoot + FADE + air >= card.pendTop() - 1, name + " a card too short keeps the first step");
            }
          }
  assert.ok(seen > 60, `most of these cards have room for the second step: ${seen}`);
});

test("a response of one line keeps that line, and one with none keeps its top", () => {
  for (const count of [1, 0]) {
    const card = cardAt({ count });
    const { type } = stepper(card);
    type(600);
    const gap = card.pendTop() - (card.secondFoot + FADE + card.air);
    assert.ok(Math.abs(gap) <= 1, `${count} lines: ${gap}`);
  }
});

test("the answer goes to its head at the second step and back where it was when cut back, not when sent", () => {
  const card = cardAt();
  const { type } = stepper(card);
  card.m.scroll = 340;
  type(600);
  assert.equal(card.m.scroll, 0, "its first two lines in sight");
  const tall = parseFloat(card.boxStyle["--pipe-tall"]);
  assert.ok(Math.abs(card.pendTop() - (card.secondFoot + FADE + card.air)) <= 1, "measured as at its head");
  assert.ok(tall > card.first);
  type(200);
  assert.equal(card.m.scroll, 340, "cut back, it is read on where it was");
  type(600);
  card.m.text = "";
  type(44);
  assert.equal(card.m.scroll, 0, "sent, the row is empty and the answer stays at its head");
});

test("a card that changes size while piped takes a new second step, and its own writes settle", () => {
  const card = cardAt();
  const { context, type } = stepper(card);
  type(600);
  const before = card.boxStyle["--pipe-tall"];
  // the window and the layout settings change the card; nothing is typed (words: false)
  context.pipeStep("c1", false);
  assert.equal(card.boxStyle["--pipe-tall"], before, "unchanged, nothing is written again");
  const taller = cardAt({ height: 860 });
  const t = stepper(taller);
  t.type(600);
  assert.ok(parseFloat(taller.boxStyle["--pipe-tall"]) > parseFloat(before), "a taller card has a taller second step");
});

test("the send square keeps its seat at the second step on a board drawn smaller than its stage", () => {
  // a row 420 tall in its own pixels, on a stage drawn at S: what the page sets
  // the square's margin to, whatever S is, and on the phone (no scale given)
  const seat = (S, given) => {
    const context = vm.createContext({ addEventListener() {}, setTimeout() {}, clearTimeout() {},
      getComputedStyle: () => ({ lineHeight: "25.5px", paddingTop: "7.5px", paddingBottom: "7.5px" }) });
    vm.runInContext(read("card-logic.js"), context, { filename: "card-logic.js" });
    const ta = { scrollHeight: 420, clientHeight: 420, getBoundingClientRect: () => ({ height: 420 * S }) };
    const square = { offsetHeight: 24, style: {} };
    if (given) context.seatSquare(ta, square, S); else context.seatSquare(ta, square);
    return parseFloat(square.style.marginBottom);
  };
  const full = seat(1, false);
  for (const S of [0.62, 0.8, 0.87]) assert.ok(Math.abs(seat(S, true) - full) < 1e-6, `at ${S}`);
  assert.ok(seat(0.87, false) < full - 40, "read unscaled, a tall row pushed the square off the card");
  // the board gives it the stage's scale, and the phone leaves it as it was
  assert.match(HTML, /pipeStep\(b\.id\);[^\n]*\n(?:[^\n]*\n){0,8}?\s*seatSquare\(ta, send, stageScale \|\| 1\);/);
  assert.match(read("m.html"), /seatSquare\(ta, send\);/);
});

test("the answer's fade ends on the top of the row's line on a board drawn smaller than its stage", () => {
  // the band the mask is cut to, in the answer's own pixels: the scroller's foot
  // and the row's top read on screen at S, the clear air in the answer's pixels
  const context = vm.createContext({ getComputedStyle: () => ({ marginBottom: "25px" }) });
  vm.runInContext(fn("boxBand"), context);
  for (const S of [1, 0.87, 0.62])
    for (const band of [45, 262, 423]) {
      const reply = { getBoundingClientRect: () => ({ bottom: 800 * S }) };
      const wrap = { getBoundingClientRect: () => ({ top: (800 - (band - 25)) * S }) };
      assert.equal(context.boxBand(reply, wrap, 0, S), band, `${band} at ${S}`);
    }
  // read unscaled at .87, a band of 423 came 54 short: the answer ran on at full ink into the line
  const reply = { getBoundingClientRect: () => ({ bottom: 800 * 0.87 }) };
  const wrap = { getBoundingClientRect: () => ({ top: (800 - 398) * 0.87 }) };
  assert.ok(423 - context.boxBand(reply, wrap) > 50);
  // the band written for the mask takes the stage's scale; the snap's own reading is as it was
  assert.match(fn("watchBand"), /sentBand\(el, boxBand\(el\.replyview, el\.pendwrap, 0, stageScale \|\| 1\)\)/);
  assert.match(fn("snapCard"), /boxBand\(view, el\.pendwrap, seat\) - answH/);
});

// ---- the brace ------------------------------------------------------------------------
const brace = vm.createContext({});
vm.runInContext(cut("const TWO = {", "\n") + "\n" + fn("pipeBrace"), brace);
const TWO = vm.runInContext("TWO", brace);

test("the brace is a } on the card's right and a { on its left, square and dashed, its lower part stretching", () => {
  const card = { left: 466, top: 52, width: 507, height: 760 };
  const most = { height: 684 };
  const segs = b => b.segments.map(s => s.map(v => Math.round(v * 100) / 100));
  for (const side of ["right", "left"]) {
    const s = side === "left" ? -1 : 1;
    const x = s > 0 ? 973 + 48 : 466 - 48 - 400;
    const tall = brace.pipeBrace(card, { left: x, top: 90, width: 400, height: 684 }, side, most, 14);
    const short = brace.pipeBrace(card, { left: x, top: 90, width: 400, height: 300 }, side, most, 14);
    const edge = s > 0 ? 973 : 466, near = s > 0 ? x : x + 400;
    for (const b of [tall, short]) {
      assert.ok(close(b.spine, (edge + near) / 2), side + ": its spine in the middle of the gap");
      // every segment straight, so every corner square
      for (const [x1, y1, x2, y2] of b.segments) assert.ok(x1 === x2 || y1 === y2, "no slant and no curve");
      // the arms reach the card's edge, the point the response's
      const ends = b.segments.map(g => g[2]);
      assert.equal(ends.filter(v => v === edge).length, 2, side + ": two arms to the card");
      assert.equal(ends.filter(v => v === near).length, 1, side + ": one point to the response");
      // the arms reach out toward the card from the spine, the point toward the response
      for (const g of b.segments) if (g[1] === g[3]) assert.ok(Math.sign(g[2] - b.spine) === (g[2] === edge ? -s : s));
    }
    assert.ok(close(tall.top, 104) && close(tall.foot, 90 + 684 - 14), "in by the corner at its top and foot");
    assert.ok(close(tall.point - tall.top, short.point - short.top), "the upper part keeps its height");
    assert.ok(close(tall.point - tall.top, most.height * TWO.share), "where the box's first line stands");
    assert.ok((tall.foot - tall.point) - (short.foot - short.point) > 300, "the lower part stretches with the response");
    assert.notDeepEqual(segs(tall), segs(short));
  }
  // a response so short the point would pass the middle has it at the middle
  const tiny = brace.pipeBrace(card, { left: 1021, top: 300, width: 400, height: 100 }, "right", most, 14);
  assert.ok(close(tiny.point, (tiny.top + tiny.foot) / 2));
  // no room for a line between them, no brace
  assert.equal(brace.pipeBrace(card, { left: 976, top: 90, width: 400, height: 300 }, "right", most, 14), null);
  // it is drawn as the box's lines are: the card's edge colour, the box's dashes and width
  const draw = fn("pipeLine");
  assert.match(draw, /borderTopColor/);
  assert.match(draw, /stroke-dasharray="' \+ TWO\.dash \+ ' ' \+ TWO\.space/);
  assert.match(draw, /stroke-width="' \+\s*TWO\.width/);
  assert.ok(!/accent|purple|#[0-9a-f]{3,6}/i.test(draw), "no colour of its own");
});

// ---- which side --------------------------------------------------------------------
function placer({ box = false, roomRight = true, roomLeft = true } = {}) {
  const classes = new Set(["on"]), body = new Set(), style = {};
  const PIPE = { side: null, rise: { t: 1, raf: 0, then: null },
    el: { classList: { contains: c => classes.has(c) }, style },
    line: { classList: { remove() {}, add() {} } },
    view: { want: () => ({ height: 400 }) } };
  const rect = { ...CARD };
  const fit = fitAt(1512);
  const most = MagicBox.place(rect, fit);
  const context = vm.createContext({
    PIPE, MagicBox: {
      place: (r, f, want, side) => {
        const at = MagicBox.place(r, f, want, side);
        return { ...at, shown: side === "left" ? roomLeft && at.shown : roomRight && at.shown };
      },
    },
    magicRoom: () => ({ S: 1, rect, fit, most: { ...most, shown: roomRight } }),
    frameLimits: () => ({ left: fit.left + 16 }), FRAME_CLEAR: 16,
    boardMagicShown: () => box, pipeLine: () => {}, magicRise: () => {},
    document: { body: { classList: { toggle: (c, yes) => (yes ? body.add(c) : body.delete(c)), remove: c => body.delete(c) } } },
  });
  vm.runInContext(fn("pipePlace"), context);
  return { context, PIPE, body, style, set: v => Object.assign(context, v) };
}

test("it stands on the right, on the left when the box is there or the right has no room, and keeps its side", () => {
  const right = placer();
  right.context.pipePlace();
  assert.equal(right.PIPE.side, "right");
  assert.ok(parseFloat(right.style.left) > CARD.left + CARD.width, "right of the card");
  assert.equal(right.body.has("pipeleft"), false, "the ticket list and the clock stay as they are");

  const left = placer({ box: true });
  left.context.pipePlace();
  assert.equal(left.PIPE.side, "left", "the card's box stands on the right");
  assert.ok(parseFloat(left.style.left) + parseFloat(left.style.width) < CARD.left, "left of the card, over the ticket list");
  assert.equal(left.body.has("pipeleft"), true, "the ticket list and the clock fade down");

  const narrow = placer({ roomRight: false });
  narrow.context.pipePlace();
  assert.equal(narrow.PIPE.side, "left", "no room on the right");

  // out on the left, the box closing leaves it where it stands
  left.set({ boardMagicShown: () => false });
  left.context.pipePlace();
  assert.equal(left.PIPE.side, "left");
  // out on the right, a box coming there sends it left
  right.set({ boardMagicShown: () => true });
  right.context.pipePlace();
  assert.equal(right.PIPE.side, "left");
  assert.equal(right.body.has("pipeleft"), true);

  // no room either side: hidden where it is, the ticket list as it was
  const none = placer({ roomRight: false, roomLeft: false });
  none.context.pipePlace();
  assert.equal(none.style.visibility, "hidden");
  assert.equal(none.body.has("pipeleft"), false);
  // sinking back into the card, the ticket list comes back with it
  const sinking = placer({ box: true });
  sinking.PIPE.rise.then = () => {};
  sinking.context.pipePlace();
  assert.equal(sinking.body.has("pipeleft"), false);
});

// ---- the keys ------------------------------------------------------------------------
function jumper({ side = "right", held = false, shown = true, boxHeld = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    PIPE: { side }, pipeShown: () => shown, pipeHeld: () => held, boardMagicHeld: () => boxHeld,
    pipeEnter: () => calls.push("enter"), pipeBack: () => calls.push("back"),
  });
  vm.runInContext(fn("pipeJump"), context);
  const press = (dir, repeat = false) => {
    const e = { repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    return { took: context.pipeJump(e, dir), e };
  };
  return { press, calls };
}

test("control+option toward the response puts the keys in it, and away brings them back", () => {
  // on the right: right goes in, left comes back
  let j = jumper();
  assert.deepEqual([j.press(1).took, j.calls], [true, ["enter"]]);
  j = jumper({ held: true });
  assert.deepEqual([j.press(-1).took, j.calls], [true, ["back"]]);
  j = jumper({ held: true });
  const again = j.press(1);
  assert.deepEqual([again.took, again.e.defaultPrevented, j.calls], [true, true, []], "already in it");
  // on the left: left goes in, right comes back
  j = jumper({ side: "left" });
  assert.deepEqual([j.press(-1).took, j.calls], [true, ["enter"]]);
  j = jumper({ side: "left", held: true });
  assert.deepEqual([j.press(1).took, j.calls], [true, ["back"]]);
  // toward the magic box, or out of it, the key is the box's
  j = jumper({ side: "left" });
  assert.deepEqual([j.press(1).took, j.press(1).e.defaultPrevented, j.calls], [false, false, []]);
  j = jumper({ side: "left", boxHeld: true });
  assert.deepEqual([j.press(-1).took, j.calls], [false, []], "left from the held box goes back to the card");
  // nothing out, or hidden for want of room: the key is not its own
  j = jumper({ shown: false });
  assert.deepEqual([j.press(1).took, j.calls], [false, []]);
  // a held key goes once
  j = jumper();
  const held = j.press(1, true);
  assert.deepEqual([held.took, held.e.defaultPrevented, j.calls], [true, true, []]);
  // and the board's key runs it ahead of the box's own
  assert.match(cut("  magicJump(e, shortcut){", "\n  create(e){"), /if \(draft \|\| !boardResponseCard\(\)\) return;\s*if \(pipeJump\(e, shortcut\.value\)\) return;/);
});

test("control+option+up and down treat it as the card's response while it is out", () => {
  const doc = { activeElement: null };
  const title = { id: "title" }, reply = { id: "reply" }, ta = { id: "ta" }, words = { id: "pipe words" };
  const calls = [];
  const context = vm.createContext({ document: doc, addEventListener() {}, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(read("card-logic.js"), context, { filename: "card-logic.js" });
  context.els = { c1: { titleEl: { contains: n => n === title, isContentEditable: false }, reply,
    field: { focused: () => doc.activeElement === ta } } };
  context.editTitle = () => calls.push("title");
  context.replyCaret = () => calls.push("card answer");
  const toBox = () => calls.push("box");
  const place = step => context.cardPlace("c1", step, toBox);
  // nothing out: the card's own answer, as always
  assert.equal(vm.runInContext("cardAnswerOff", context), null, "the phone and a card with nothing out");
  doc.activeElement = ta; place(-1);
  assert.deepEqual(calls.splice(0), ["card answer"]);
  // out: up from the typing box goes into it, and down and up from it go on
  context.out = { holds: n => n === words, go: () => calls.push("pipe") };
  vm.runInContext("cardAnswerOff = id => out", context);
  doc.activeElement = ta; place(-1);
  assert.deepEqual(calls.splice(0), ["pipe"]);
  doc.activeElement = words; place(1);
  assert.deepEqual(calls.splice(0), ["box"]);
  doc.activeElement = words; place(-1);
  assert.deepEqual(calls.splice(0), ["title"]);
  doc.activeElement = null; place(-1);
  assert.deepEqual(calls.splice(0), ["pipe"], "with nothing focused, up lands on the response");
  // the board names it so only for the card on screen with it out
  assert.match(HTML, /\ncardAnswerOff = id => id === shownId && pipeShown\(\) \? \{ holds: node => PIPE\.el\.contains\(node\), go: pipeEnter \} : null;/);
});

test("control+S scrolls it while it holds the keys, and command+A picks its words alone", () => {
  assert.match(cut("const boardShortcutActions = {", "\n};"),
    /responseScroll\(e\)\{\s*responseScrollKey\(e, pipeHeld\(\) \? pipeScrollCard : boardMagicHeld\(\) \? boardMagicScrollCard : boardResponseCard\);/);
  const scroll = fn("pipeScrollCard");
  assert.match(scroll, /if \(!card \|\| !pipeHeld\(\) \|\| PIPE\.id === null\) return null;/);
  // the words it scrolls are its body, and the caret's own words count as the page
  assert.match(HTML, /PIPE\.part = \{ replyview: PIPE\.body, box: PIPE\.el, get reply\(\)\{ return PIPE\.body\.querySelector\("\.mbtext"\); \} \};/);
  assert.match(HTML, /const words = pipeHeld\(\) && PIPE\.part\.reply;[\s\S]*?getSelection\(\)\.selectAllChildren\(words\);/);
  // the keys go in with the response's caret, as in the card's answer, and come back to the typing box as the box's do
  assert.match(fn("pipeEnter"), /pipeRemember\(\);\s*magicHold\(false\);\s*pipeHold\(true\);\s*replyCaret\(PIPE\.part\);/);
  assert.match(fn("pipeBack"), /if \(keysBack\(came\)\) return;/);
  assert.match(fn("magicBack"), /if \(keysBack\(came\)\) return;/);
});

// ---- the look --------------------------------------------------------------------------
test("it has no edge and no bar, the box's corners and shadows, words fading at both ends, and it is never faded", () => {
  const style = HTML.slice(0, HTML.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = sel => {
    const found = style.match(new RegExp("\\n  " + sel.replace(/[.()]/g, "\\$&") + "\\{([^}]*)\\}"));
    assert.ok(found, "no rule " + sel);
    return found[1];
  };
  assert.match(style, /\n  #pipebox\{background:var\(--card\); border:none; border-radius:var\(--mb-round\);\s*box-shadow:var\(--shade-lighter\); transition:box-shadow \.2s\}/);
  assert.equal(rule("#pipebox.keys"), "box-shadow:var(--shade-raised)");
  assert.equal(rule("#pipebox .mbbar"), "display:none");
  assert.equal(rule("body.lowered #pipebox.on"), "box-shadow:none");
  assert.ok(!/#pipebox[^{]*\{[^}]*opacity:var\(--shade-unselected\)/.test(style), "never faded as the box is");
  // the sheet's words, which fade at both ends of their scroll (--upband, --downband)
  assert.match(HTML, /<section id="pipebox" class="magicbox"/);
  assert.match(read("card-tokens.css"), /\.magicbox \.mbbody:is\(\[data-kind="text"\], \[data-kind="markdown"\]\)\{\s*-webkit-mask-image:linear-gradient\(to bottom,/);
  assert.match(fn("pipeDraw"), /PIPE\.view\.draw\(\{ kind: "markdown", text: raw \}\);/);
  // the shadows rise as the box's do, with the box's own numbers
  const unrise = s => s.replace(/calc\(([^)]*?) \* var\(--rise\)\)/g, "$1").replace(/\s+/g, " ").trim();
  const shade = name => style.match(new RegExp("--" + name + ":([^;]*);"))[1].replace(/\s+/g, " ").trim();
  assert.equal(unrise(rule("#pipebox.rising").replace(/^--rise:0; transition:none;\s*box-shadow:/, "")), shade("shade-lighter"));
  assert.equal(unrise(rule("#pipebox.rising.keys").replace(/^\s*box-shadow:/, "")), shade("shade-raised"));
  // the brace wears the box's lines' shadow and sits beneath the card
  assert.match(style, /\n  body\.focus #pipeline\.on > g\{filter:drop-shadow\(0 2px 9px rgba\(60,45,20,\.18\)\) drop-shadow\(0 1px 1\.5px rgba\(60,45,20,\.10\)\)\}/);
  assert.ok(HTML.indexOf('<svg id="pipeline"') < HTML.indexOf("<main>"));
  // piped left, the ticket list and the clock fade well down, and back
  assert.equal(rule("body.focus.pipeleft :is(#tickets, #clockbox)"), "opacity:.26");
  assert.match(rule("body.focus :is(#tickets, #clockbox)"), /^transition:opacity 1s /);
  // the card settles while it holds the keys, as for the box, at the same weight
  assert.ok(style.includes("\n  body.focus:not(.home, .editmode):where(.pipekeys) main{box-shadow:var(--shade-lighter); opacity:var(--shade-unselected)}"));
  // its words are selectable, as the box's are
  assert.match(style, /#magicbox \.mbtext, #pipebox \.mbtext,/);
  // no accent and no purple anywhere it is dressed
  const own = (style.match(/\n  [^\n{]*#pipe(box|line)[^{]*\{[^}]*\}/g) || []).join("");
  assert.ok(own.length > 200 && !/accent|purple|#[0-9a-f]{3,8}\b/i.test(own));
});

// ---- the phone --------------------------------------------------------------------------
test("the phone page keeps one step and pipes nothing, and neither does the Mac's phone view", () => {
  const phone = read("m.html");
  for (const name of ["pipebox", "pipeline", "pipeStep", "pipeSync", "cardAnswerOff", "pipe-tall"])
    assert.ok(!phone.includes(name), "the phone has " + name);
  // the Mac board pipes only for its own card on screen, never in its phone view
  const card = vm.createContext({ FOCUS: true, shownId: "c1", draft: false, phoneWanted: false,
    document: { body: { classList: { contains: () => false } } },
    els: { c1: { box: { classList: { contains: c => c === "sel" || c === "piped" } }, reply: { textContent: "words" } } } });
  vm.runInContext(fn("pipeCard"), card);
  assert.ok(card.pipeCard(), "the board's card on screen");
  card.phoneWanted = true;
  assert.equal(card.pipeCard(), null, "the phone view");
  card.phoneWanted = false;
  card.document.body.classList.contains = c => c === "home";
  assert.equal(card.pipeCard(), null, "the home page");
});
