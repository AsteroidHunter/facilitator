// A long reply on the Mac board: the typing row grows to the sheet's cap, its
// first step, and scrolls there. Once the words would reach the line right
// under the card's top bar, the box the row stands in rises to its second step,
// as tall as leaves the response's first two lines whole above the answer's
// fade (read off the card as it is laid out, whatever the card's height, its
// title, the bubbles over the response or the stage's scale), over the magic box's time and curve,
// the row's last line staying where it was, and it sinks back only once the
// words are a whole line under the first step. With the box up the response is
// piped out beside the card as a second magic box (MagicBox.place, either side
// of the card, on the box's own rules and steps), on the right unless the card's
// box stands there or the right has no room, and tied to the card by a square
// dashed brace of two sets of three lines whose lower set stretches with it.
// Control + Option toward it puts the keys in it and away brings them back, and
// up and down treat it as the card's response. The phone page keeps one step
// and pipes nothing. Run from the pages' own source, no browser: the functions
// are cut out of index.html as written.
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
  // or the whole of the last of them, its top and its foot
  assert.deepEqual({ ...lines.pipeLines(two, 1, true) }, { top: 100, bottom: 123 });
  assert.deepEqual({ ...lines.pipeLines(laidOut([[[100, 123]]]), 2, true) }, { top: 100, bottom: 123 });
  assert.equal(lines.pipeLines(laidOut([]), 1, true), null);
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
// read in the screen's: the head (the top bar, bar high, and the title) over
// the answer, the answered bubbles at the answer's head, then the response's
// lines, and at the foot the bar: its seat (the compose) holds the row at its
// words' height under the cap in force, the sheet's first step or the box's
// height while the box is up (.tallrow, --row-box), and the seat is at least
// that box's height. the row stands on the bar's floor
const FADE = 22, ROWLINE = 25.5, ROWPAD = 7.5;
function cardAt({ S = 1, top = 52, height = 760, head = 110, answ = 80, count = 12, line = 27.9, glyph = 23,
  first = 252, air = 3.5, bar = 34 } = {}) {
  const m = { scroll: 0, text: "typed words" };
  const classes = new Set(["sel"]), boxStyle = {};
  const row = { style: { height: "44px" } };
  const up = () => classes.has("tallrow");
  const boxH = () => parseFloat(boxStyle["--row-box"]);
  const rendered = () => Math.min(parseFloat(row.style.height) || 44, up() ? boxH() : first);
  const seat = () => (up() ? Math.max(rendered(), boxH()) : rendered());
  const viewTop = top + head, foot = top + height - 22;
  const scr = v => v * S;
  const reply = { get texts() {
    return Array.from({ length: count }, (_, i) => {
      const at = viewTop + answ + i * line + (line - glyph) / 2 - m.scroll;
      return { data: "words", parentElement: { closest: () => null }, rects: [{ top: scr(at), bottom: scr(at + glyph), height: scr(glyph) }] };
    });
  }, getBoundingClientRect: () => ({ top: scr(viewTop + answ - m.scroll) }), textContent: count ? "words" : "" };
  row.getBoundingClientRect = () => ({ height: scr(rendered()), bottom: scr(foot - 1) });
  // its scroll as a browser keeps it: the words' height inside the row's own,
  // and the scroll held between the two, kept where it was as the row changes height
  let scrolled = 0;
  Object.defineProperties(row, {
    scrollHeight: { get: () => parseFloat(row.style.height) || 44 },
    clientHeight: { get: () => rendered() },
    scrollTop: { get: () => (scrolled = Math.max(0, Math.min(scrolled, row.scrollHeight - row.clientHeight))), set: v => { scrolled = v; } },
  });
  const view = { get scrollTop() { return m.scroll; }, set scrollTop(v) { m.scroll = v; } };
  const el = {
    box: { classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c),
      toggle: (c, yes = !classes.has(c)) => (yes ? classes.add(c) : classes.delete(c), yes) },
      style: { setProperty: (k, v) => { boxStyle[k] = v; }, getPropertyValue: k => boxStyle[k] || "" } },
    topbar: { getBoundingClientRect: () => ({ bottom: scr(top + bar) }) },
    replyview: view, reply, ta: row,
    pendwrap: { getBoundingClientRect: () => ({ top: scr(foot - 1 - seat()) }) },
    send: { parentNode: { getBoundingClientRect: () => ({ height: scr(seat()) }) } },
    field: { view: null, text: () => m.text },
  };
  // the second line's foot with the answer at its head, and what the fade needs under it
  const secondFoot = count >= 2 ? viewTop + answ + line + (line - glyph) / 2 + glyph
    : count === 1 ? viewTop + answ + (line - glyph) / 2 + glyph : viewTop + answ;
  // the words' height at which their first line stands on the line right under the top bar
  const reach = (foot - 1) - (top + bar) - ROWLINE + ROWPAD;
  return { el, row, m, classes, boxStyle, S, first, air, rendered, seat, pendTop: () => foot - 1 - seat(), secondFoot,
    reach, barFoot: top + bar, rowFoot: foot - 1 };
}
// the steps cut out of the page, on a clock of their own: frame() is one 1/60 s
// frame of it, running what asked for one
function stepper(card) {
  const synced = [], clock = { t: 0 }, asked = new Map();
  let next = 1;
  const context = vm.createContext(domFor({
    els: { c1: card.el }, shownId: "c1", stageScale: card.S, pipeSync: () => synced.push(1),
    getComputedStyle: node => node === card.row ? { maxHeight: card.first + "px", lineHeight: ROWLINE + "px", paddingTop: ROWPAD + "px" }
      : node === card.el.replyview ? { marginBottom: card.air + "px" }
      : { getPropertyValue: k => (k === "--replyfade" ? FADE + "px" : "") },
    RISE_MS: Number(cut("const RISE_MS = ", ",").slice("const RISE_MS = ".length)),
    performance: { now: () => clock.t },
    requestAnimationFrame: cb => { asked.set(next, cb); return next++; },
    cancelAnimationFrame: id => asked.delete(id),
  }));
  vm.runInContext(cut("function riseEase(", "\n") + "\n" + ["pipeStep", "pipeOut", "pipeReach", "rowRise", "rowRiseStep", "rowFlat", "rowBox",
    "pipeTall", "pipeLines"].map(fn).join(""), context);
  // the row's tick: set to its words' own height, then the steps
  const type = words => { card.row.style.height = words + "px"; context.pipeStep("c1"); };
  const frame = () => {
    clock.t += 1000 / 60;
    const due = [...asked]; asked.clear();
    for (const [, cb] of due) cb(clock.t);
  };
  const settle = () => { for (let i = 0; i < 200 && asked.size; i++) frame(); };
  const piped = () => card.classes.has("piped");
  return { context, type, frame, settle, synced, piped, el: card.el, pending: () => asked.size };
}

test("the row grows to the first step and scrolls there, and its box rises only once the words reach the line under the top bar", () => {
  const card = cardAt();
  const { type, frame, settle, synced, piped, el } = stepper(card);
  for (const words of [44, 95, 146, 197, 248]) {
    type(words);
    assert.equal(piped(), false, `${words} is under the first step`);
    assert.equal(card.rendered(), words, "a line at a time");
    assert.equal(card.seat(), words, "the bar as tall as the row");
  }
  // over the first step, half way to the second, at the second and past it:
  // held at the first step, scrolling, and nothing out yet
  type(300);
  const tall = el.rowTall, reach = card.reach;
  assert.ok(tall > card.first + 100, `a second step well over the first: ${tall}`);
  assert.ok(reach > tall + 100, `the line under the top bar well over the second step: ${reach} against ${tall}`);
  for (const words of [274, 300, (card.first + tall) / 2 + 2, tall, tall + 100, reach - 1, reach]) {
    type(words);
    assert.equal(piped(), false, `${words} has not reached the line under the top bar (${reach})`);
    assert.equal(card.rendered(), card.first, "the row at the first step");
    assert.equal(card.seat(), card.first, "and its box with it");
    assert.equal(card.classes.has("tallrow"), false);
  }
  // that height is where the words' first line, standing up from the row's
  // foot, comes onto the line right under the top bar
  const firstLine = words => card.rowFoot - words + ROWPAD;
  assert.ok(close(firstLine(reach), card.barFoot + ROWLINE), "at the reach the first line is a line under the bar");
  // reached: out, and the box rises over the magic box's second on its curve
  type(reach + 2);
  assert.ok(firstLine(reach + 2) < card.barFoot + ROWLINE && firstLine(reach + 2) > card.barFoot, "the first line on the line under the bar");
  assert.equal(piped(), true, "the line under the top bar reached");
  assert.ok(synced.length > 0, "the card on screen pipes its response");
  assert.equal(card.seat(), card.first, "the box has not jumped");
  const ease = vm.runInContext("riseEase", stepper(cardAt()).context);
  const seen = [];
  for (let i = 1; i <= 60; i++) {
    frame();
    seen.push(card.seat());
    const t = Math.min(1, i / 60);
    assert.ok(Math.abs(card.seat() - (card.first + (tall - card.first) * ease(t))) < 0.02, `frame ${i} on the curve`);
  }
  settle();
  assert.equal(card.seat(), tall, "risen to the second step");
  const steps = seen.map((v, i) => v - (i ? seen[i - 1] : card.first));
  assert.ok(steps.every(d => d >= 0), "upward only");
  assert.ok(Math.max(...steps) <= 2.01 * (tall - card.first) / 60, "never faster than twice its mean pace");
  assert.ok(steps[0] < 0.01 * (tall - card.first) && steps[59] < 0.01 * (tall - card.first), "it starts and settles calmly");
  // the words are taller than the box by then, so they fill it and scroll inside it
  assert.equal(card.rendered(), tall, "the row as tall as the box, with no room above its words");
  // cut back under it, they stand at its foot at their own height, never stretched to its top,
  // and the box comes down with them
  type(tall - 100);
  assert.equal(card.rendered(), tall - 100, "the row as tall as its words");
  assert.equal(card.seat(), tall - 100, "and its box no taller");
});

test("typing and deleting at either edge never flicks it between piped and not", () => {
  const out = vm.createContext({});
  vm.runInContext(fn("pipeOut"), out);
  const first = 252, reach = 685, line = 25.5;
  // out once the words reach the line under the top bar, and only then
  assert.equal(out.pipeOut(false, reach, first, reach, line), false);
  assert.equal(out.pipeOut(false, reach + 1, first, reach, line), true);
  for (const words of [300, 390, 527, 600]) assert.equal(out.pipeOut(false, words, first, reach, line), false, `${words}: over the first step, half way or the second is not enough`);
  // once out, held until a whole line under the first step
  for (const words of [reach, 300, first, first - line + 1]) assert.equal(out.pipeOut(true, words, first, reach, line), true, `${words} holds it out`);
  assert.equal(out.pipeOut(true, first - line, first, reach, line), false);
  assert.equal(out.pipeOut(true, 44, first, reach, line), false, "sent");
  // a card so short its top bar is under the first step's top: out past the first, held the same way
  assert.equal(out.pipeOut(false, first + 1, first, first - 30, line), true);
  assert.equal(out.pipeOut(false, 0, 0, 0, line), false, "a row not laid out");

  // through the page's steps: a line typed and taken back at the upper edge, over and over
  const card = cardAt();
  const { type, frame, piped, el } = stepper(card);
  type(300);
  const edge = card.reach;
  const above = edge + ROWLINE / 2, below = edge - ROWLINE / 2;
  const seen = [];
  for (let i = 0; i < 20; i++) {
    type(i % 2 ? below : above);
    seen.push(piped());
    frame(); frame();
  }
  assert.deepEqual(seen, seen.map(() => true), "out at the first line on the line under the top bar, and it stays out");
  assert.equal(el.rowRise.dir, 1, "its box never turned back");
  // and at the lower edge, deleting: held at the first step's last line, in a line under it
  for (let i = 0; i < 6; i++) { type(card.first - 4.5); frame(); assert.equal(piped(), true, "a line under the first step's cap still holds it"); }
  type(card.first - ROWLINE - 4.5);
  assert.equal(piped(), false, "a whole line under: back in");
  const back = [];
  for (let i = 0; i < 20; i++) { type(i % 2 ? card.first - ROWLINE - 4.5 : card.first - 4.5); back.push(piped()); frame(); }
  assert.deepEqual(back, back.map(() => false), "typed back up to the first step it stays in, until the line under the top bar again");
});

test("the decision moves nothing it measures: the words keep their height and the second step reads the same as the box rises", () => {
  const card = cardAt();
  const { context, type, frame, el } = stepper(card);
  type(300);
  const tall = el.rowTall, words = Math.round(card.reach + 40);
  type(words);
  const reads = [], reaches = [];
  for (let i = 0; i < 70; i++) {
    frame();
    // the page follows its own writes (the observer's pipeStep with no new words)
    context.pipeStep("c1", false);
    reads.push(context.pipeTall(el));
    reaches.push(context.pipeReach(el, card.row, { paddingTop: ROWPAD + "px" }, ROWLINE));
    assert.equal(card.row.style.height, words + "px", "the row's own height is only ever its words'");
    assert.equal(el.rowWords, words);
  }
  assert.ok(reads.every(v => Math.abs(v - tall) < 0.5), `the second step at every height of the box: ${Math.min(...reads)} to ${Math.max(...reads)}`);
  assert.ok(reaches.every(v => close(v, card.reach)), "and the line under the top bar the same");
  assert.equal(el.rowTall, tall);
  assert.ok(card.classes.has("piped"));
});

test("the box opens over the words: with the caret up in them, what is out of sight under the row stays under it as the box rises", () => {
  for (const hidden of [2 * ROWLINE, 0]) {
    const card = cardAt();
    const { type, frame, settle, el } = stepper(card);
    type(300);
    const words = Math.round(card.reach + 40);
    type(words);
    assert.ok(card.classes.has("piped"));
    // the caret a few lines up in the words, as the keys leave it, with two lines under the row's view
    // (or at the end, with none)
    const row = card.row, under = () => row.scrollHeight - row.scrollTop - row.clientHeight;
    row.scrollTop = row.scrollHeight - row.clientHeight - hidden;
    assert.ok(Math.abs(under() - hidden) < 1e-6);
    const seen = [];
    for (let i = 0; i < 70; i++) { frame(); seen.push(under()); }
    settle();
    assert.ok(card.seat() === el.rowTall && card.rendered() === el.rowTall, "risen, the row filling the box");
    assert.ok(seen.every(v => Math.abs(v - hidden) < 0.51), `the words' foot held where it stood: ${Math.min(...seen)} to ${Math.max(...seen)} under, against ${hidden}`);
  }
});

test("deleted back clearly under the first step the box sinks to the words on the same curve; sent it is down at once", () => {
  const card = cardAt();
  const { type, frame, settle, piped, el, pending } = stepper(card);
  type(300); type(2000); settle();
  const tall = el.rowTall;
  const words = card.first - ROWLINE - 4.5;
  type(words);
  assert.equal(piped(), false);
  assert.equal(card.seat(), tall, "it has not dropped");
  const seen = [];
  while (pending()) { frame(); seen.push(card.seat()); }
  assert.ok(seen.length >= 59 && seen.length <= 61, `over the second: ${seen.length} frames`);
  assert.ok(seen.every((v, i) => v <= (i ? seen[i - 1] : tall)), "downward only");
  assert.equal(card.seat(), words, "down to the row's own height");
  assert.equal(card.classes.has("tallrow"), false);
  assert.ok(Math.abs(seen.at(-2) - words) < 0.5, "and the box comes off at the words' height, with no step at the end");
  // sent: the row empties and the box is down in the same breath
  type(300); type(2000); settle();
  card.m.text = "";
  type(44);
  assert.equal(piped(), false);
  assert.equal(card.classes.has("tallrow"), false, "down at once");
  assert.equal(card.seat(), 44);
  assert.equal(pending(), 0);
});

test("words deleted while it is out take the box down with them, and it goes back in only a whole line under the first step", () => {
  const card = cardAt();
  const { type, frame, settle, piped, el, pending } = stepper(card);
  const lines = n => n * ROWLINE + 2 * ROWPAD;
  type(300); type(lines(30)); settle();
  const tall = el.rowTall;
  assert.ok(piped() && card.seat() === tall, "out, the box at the second step");
  // a run of lines selected and deleted, or cut: down to ten, at once and still out
  type(lines(10));
  assert.ok(lines(10) > card.first && lines(10) < tall);
  assert.equal(piped(), true, "ten lines are over the first step: still out");
  assert.equal(card.seat(), lines(10), "the box as tall as the ten lines");
  assert.equal(card.rendered(), lines(10));
  assert.equal(pending(), 0, "nothing left to play out");
  // a line typed back, then more than the box holds: it grows with them to the second step and no further
  type(lines(11));
  assert.equal(card.seat(), lines(11));
  type(lines(40));
  assert.equal(card.seat(), tall, "back at the second step");
  assert.equal(card.rendered(), tall, "the words scrolling in it");
  // backspaced line by line: over the second step it holds, under it the box follows each line
  const seen = [];
  for (let n = 39; n >= 1; n--) {
    type(lines(n));
    seen.push({ n, out: piped(), seat: card.seat() });
    if (!piped()) break;
  }
  for (const s of seen.filter(s => s.out)) assert.equal(s.seat, Math.min(tall, lines(s.n)), `${s.n} lines`);
  const back = seen.at(-1);
  assert.ok(back.n === Math.floor((card.first - ROWLINE - 2 * ROWPAD) / ROWLINE), `in at ${back.n} lines, a whole line under the first step`);
  assert.ok(seen.at(-2).out && lines(seen.at(-2).n) > card.first - ROWLINE, "held out until then");
  // and in, the box sinks the rest of the way to the words on the rise's curve
  const from = card.seat();
  const sink = [];
  while (pending()) { frame(); sink.push(card.seat()); }
  assert.ok(from <= lines(back.n + 1) + 1e-9 && sink.every(v => v <= from + 1e-9), "never back up");
  assert.equal(card.seat(), lines(back.n));
  assert.equal(card.classes.has("tallrow"), false);
  // ten lines left out, then a run deleted that takes it under: it sinks from the ten lines' height, not the second step
  type(lines(30)); settle();
  type(lines(10));
  type(lines(4));
  assert.equal(piped(), false);
  assert.equal(card.seat(), lines(10), "the sink starts where the box stood");
  const down = [];
  while (pending()) { frame(); down.push(card.seat()); }
  assert.ok(down.length >= 59 && down.length <= 61, `over the second: ${down.length} frames`);
  assert.ok(down.every((v, i) => v <= (i ? down[i - 1] : lines(10))), "downward only");
  assert.equal(card.seat(), lines(4));
  // all of it selected and deleted: down at once, as when sent
  type(lines(30)); settle();
  card.m.text = "";
  type(lines(1));
  assert.equal(piped(), false);
  assert.equal(card.classes.has("tallrow"), false, "down at once");
  assert.equal(card.seat(), lines(1));
  assert.equal(pending(), 0);
});

test("the second step leaves the response's first two lines whole, at every card height, title, bubble and scale", () => {
  let seen = 0;
  for (const S of [1, 0.8, 0.62])
    for (const height of [520, 640, 760, 860])
      for (const head of [80, 140])
        for (const answ of [0, 80, 160])
          for (const air of [3.5, 25.05]) {
            const card = cardAt({ S, height, head, answ, air });
            const { type, settle, el } = stepper(card);
            type(300); type(2000); settle();
            const tall = el.rowTall;
            const name = JSON.stringify({ S, height, head, answ, air });
            assert.ok(tall >= card.first, name + " never under the first step");
            if (tall > card.first) {
              // the box's top: the second line's foot, the fade and the clear air over it, to a pixel
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
    const { type, settle } = stepper(card);
    type(300); type(2000); settle();
    const gap = card.pendTop() - (card.secondFoot + FADE + card.air);
    assert.ok(Math.abs(gap) <= 1, `${count} lines: ${gap}`);
  }
});

test("the answer goes to its head at the second step and back where it was when cut back, not when sent", () => {
  const card = cardAt();
  const { type, settle, el } = stepper(card);
  card.m.scroll = 340;
  type(300);
  assert.equal(card.m.scroll, 340, "not yet: under the line below the top bar");
  type(2000);
  assert.equal(card.m.scroll, 0, "its first two lines in sight");
  settle();
  assert.ok(Math.abs(card.pendTop() - (card.secondFoot + FADE + card.air)) <= 1, "measured as at its head");
  assert.ok(el.rowTall > card.first);
  type(200);
  assert.equal(card.m.scroll, 340, "cut back, it is read on where it was");
  type(2000);
  card.m.text = "";
  type(44);
  assert.equal(card.m.scroll, 0, "sent, the row is empty and the answer stays at its head");
});

test("a card that changes size while piped takes a new second step, and its own writes settle", () => {
  const card = cardAt();
  const { context, type, settle, el } = stepper(card);
  type(300); type(2000); settle();
  const before = el.rowTall, box = card.boxStyle["--row-box"];
  // the window and the layout settings change the card; nothing is typed (words: false)
  context.pipeStep("c1", false);
  assert.equal(el.rowTall, before, "unchanged");
  assert.equal(card.boxStyle["--row-box"], box, "nothing is written again");
  const taller = cardAt({ height: 860 });
  const t = stepper(taller);
  t.type(300); t.type(2000); t.settle();
  assert.ok(taller.el.rowTall > before, "a taller card has a taller second step");
  assert.equal(taller.seat(), taller.el.rowTall, "and its box stands at it");
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
vm.runInContext(cut("const TWO = {", "\n") + "\n" + cut("const PIPE_STROKE = ", "\n") + "\n" + fn("pipeBrace"), brace);
const TWO = vm.runInContext("TWO", brace), STROKE = vm.runInContext("PIPE_STROKE", brace);

test("the brace is a { to a response on the card's right and a } to one on its left: six square lines in two sets, touching neither", () => {
  const card = { left: 466, top: 52, width: 507, height: 760 };
  const most = { height: 684 };
  // the response's first line 34 down from its top, a line of its words 27.9 high, ends 8 short
  const LEAD = 34, APART = 27.9, CLEAR = 8, opts = { round: 14, lead: LEAD, apart: APART, clear: CLEAR };
  const segs = b => b.segments.map(s => s.map(v => Math.round(v * 100) / 100));
  const level = g => g[1] === g[3], upright = g => g[0] === g[2];
  for (const side of ["right", "left"]) {
    const s = side === "left" ? -1 : 1;
    const x = s > 0 ? 973 + 48 : 466 - 48 - 400;
    const tall = brace.pipeBrace(card, { left: x, top: 90, width: 400, height: 684 }, side, most, opts);
    const short = brace.pipeBrace(card, { left: x, top: 90, width: 400, height: 300 }, side, most, opts);
    const edge = s > 0 ? 973 : 466, near = s > 0 ? x : x + 400;
    for (const b of [tall, short]) {
      assert.ok(close(b.spine, (edge + near) / 2), side + ": its spine in the middle of the gap");
      // six lines, an upper set of three and a lower set of three, every one straight, so every corner square
      assert.equal(b.segments.length, 6);
      assert.deepEqual([b.upper.length, b.lower.length], [3, 3]);
      for (const g of b.segments) assert.ok(level(g) !== upright(g), "no slant and no curve");
      // each set: a level line, an upright one, a level one, turning square at the spine
      for (const set of [b.upper, b.lower]) {
        assert.equal(set.map(level).join(), "true,false,true");
        assert.ok(set.every(g => Math.abs(g[0] - b.spine) <= STROKE / 2 + 1e-9));
      }
      // the arms point to the response's edge and the two lines of the point to the card's,
      // each stopping CLEAR short of it: { on the right, its arms out to the right; } on the left, out to the left
      const [topArm, , upPoint] = b.upper, [downPoint, , footArm] = b.lower;
      for (const arm of [topArm, footArm]) assert.ok(close(arm[2], near - s * CLEAR) && Math.sign(arm[2] - b.spine) === s, side + ": an arm toward the response");
      for (const nub of [upPoint, downPoint]) assert.ok(close(nub[2], edge + s * CLEAR) && Math.sign(nub[2] - b.spine) === -s, side + ": the point toward the card");
      // no end of any line within CLEAR of either box
      const xs = b.segments.flatMap(g => [g[0], g[2]]), lo = Math.min(edge, near), hi = Math.max(edge, near);
      assert.ok(xs.every(v => v >= lo + CLEAR - 1e-9 && v <= hi - CLEAR + 1e-9), side + ": touching neither box");
      // the two lines of the point a line of the response's words apart, either side of it
      assert.ok(close(downPoint[1] - upPoint[1], APART));
      assert.ok(close((downPoint[1] + upPoint[1]) / 2, b.point));
      // each spine is dashed from the point, so the corners there close
      assert.ok(close(b.upper[1][1], upPoint[1] + STROKE / 2) && close(b.lower[1][1], downPoint[1] - STROKE / 2));
    }
    assert.ok(close(tall.top, 90 + LEAD), "its top arm level with the top of the response's first line");
    assert.ok(close(tall.foot, 90 + 684 - 14), "its foot arm in by the corner at the foot");
    assert.ok(close(tall.point - tall.top, short.point - short.top), "the upper set keeps its height");
    assert.ok(close(tall.point - tall.top, most.height * TWO.share), "where the box's first line stands");
    assert.ok((tall.foot - tall.point) - (short.foot - short.point) > 300, "the lower set stretches with the response");
    assert.deepEqual(segs(tall).slice(0, 3), segs(short).slice(0, 3), "and only the lower set");
    assert.notDeepEqual(segs(tall).slice(3), segs(short).slice(3));
  }
  // a response so short the point would pass the middle has it at the middle, the
  // two lines there no further apart than half of what is left of the brace
  const tiny = brace.pipeBrace(card, { left: 1021, top: 300, width: 400, height: 100 }, "right", most, opts);
  assert.ok(close(tiny.point, (tiny.top + tiny.foot) / 2));
  assert.ok(tiny.lower[0][1] - tiny.upper[2][1] <= (tiny.foot - tiny.top) / 2 + 1e-9);
  // with no word lines given it starts in by the corner, as the box does
  assert.ok(close(brace.pipeBrace(card, { left: 1021, top: 90, width: 400, height: 684 }, "right", most, { round: 14 }).top, 104));
  // no room either side of the spine for a clear end and a dash, no brace
  assert.equal(brace.pipeBrace(card, { left: 976, top: 90, width: 400, height: 300 }, "right", most, opts), null);
  const least = 2 * (CLEAR + STROKE / 2 + TWO.dash);
  assert.equal(brace.pipeBrace(card, { left: 973 + least - 1, top: 90, width: 400, height: 300 }, "right", most, opts), null);
  assert.ok(brace.pipeBrace(card, { left: 973 + least + 1, top: 90, width: 400, height: 300 }, "right", most, opts));
  // it is drawn as the box's lines are: the card's edge colour and the box's dashes, at half
  // the box's width, from the response's own first line and line of words, clear of both boxes
  const draw = fn("pipeLine");
  assert.match(draw, /borderTopColor/);
  assert.match(draw, /stroke-dasharray="' \+ TWO\.dash \+ ' ' \+ TWO\.space/);
  assert.match(draw, /stroke-width="' \+\s*PIPE_STROKE \+/);
  assert.equal(STROKE, TWO.width / 2, "half the box's lines");
  assert.match(fn("magicLine"), /stroke-width="' \+ TWO\.width \+/, "the box's own lines keep their width");
  assert.ok(!/accent|purple|#[0-9a-f]{3,6}/i.test(draw), "no colour of its own");
  // its top arm at the top of the response's first line, as the place reads it (pipeLevel),
  // with the words' scroll taken back, and in by the corner with no words
  assert.match(draw, /^function pipeLine\(card, box, side, most, lead\)\{/);
  assert.match(fn("pipeLevel"), /lead: \(own\.top - PIPE\.el\.getBoundingClientRect\(\)\.top\) \/ S \+ PIPE\.body\.scrollTop/);
  assert.match(fn("pipePlace"), /pipeLine\(room\.rect, at, side, most\[side\], level && level\.lead\);/);
  assert.match(draw, /parseFloat\(getComputedStyle\(words\)\.lineHeight\)/);
  assert.match(draw, /pipeBrace\(card, box, side, most, \{ round, lead: lead == null \? round : lead, apart, clear: PIPE_CLEAR \}\)/);
  assert.match(HTML, /const PIPE_MS = \d+, PIPE_DIM = \.1, PIPE_CLEAR = 8;/);
});

// ---- which side --------------------------------------------------------------------
// card: the first line of the card's own copy of the response (its top), the top
// of the card's answer and the top of the typing box, on the screen; with none,
// the response has no words to stand level with. S and sy: the stage's scale and
// its top on the screen. the pipe's words have their first line LEAD under its top
const LEAD = 17.86;
function placer({ box = false, roomRight = true, roomLeft = true, want = 400, card = null, S = 1, sy = 0 } = {}) {
  const classes = new Set(["on"]), style = {}, body = { scrollTop: 0 };
  const tickets = { style: { opacity: "" } }, clock = { style: { opacity: "" } };
  const reply = { style: { opacity: "" }, get first(){ return card && { top: card.first, bottom: card.first + 23.5 * S }; } };
  const PIPE = { side: null, rise: { t: 1, raf: 0, then: null }, id: "c1", top: null, body,
    el: { classList: { contains: c => classes.has(c) }, style,
      getBoundingClientRect: () => ({ top: sy + (parseFloat(style.top) || 0) * S }) },
    line: { classList: { remove() {}, add() {} } },
    aside: [tickets, clock], dimmed: null, dimAt: { reply: "", aside: "" },
    view: { want: () => ({ height: want }) } };
  const words = { get first(){ const top = PIPE.el.getBoundingClientRect().top + (LEAD - body.scrollTop) * S; return { top, bottom: top + 23.5 * S }; } };
  PIPE.part = { reply: card ? words : null };
  const rect = { ...CARD };
  const fit = fitAt(1512);
  const most = MagicBox.place(rect, fit);
  const drawn = [];
  const context = vm.createContext({
    PIPE, MagicBox: {
      place: (r, f, want, side) => {
        const at = MagicBox.place(r, f, want, side);
        return { ...at, shown: side === "left" ? roomLeft && at.shown : roomRight && at.shown };
      },
    },
    magicRoom: () => ({ S, sr: { x: 0, y: sy }, rect, fit, most: { ...most, shown: roomRight } }),
    frameLimits: () => ({ left: fit.left + 16 }), FRAME_CLEAR: 16,
    boardMagicShown: () => box, pipeLine: (...args) => drawn.push(args), boxRise: () => {},
    // each line read off the page where the stand-ins above lay it
    pipeLines: node => node.first || null,
    els: { c1: { reply, replyview: { getBoundingClientRect: () => ({ top: card.view }) },
      pendwrap: { getBoundingClientRect: () => ({ top: card.pend }) } } },
  });
  vm.runInContext(cut("const PIPE_MS = ", "\n") + "\n" + cut("function riseEase(", "\n") + "\n" + fn("pipePlace") + fn("pipeLevel") + fn("pipeDim"), context);
  // what stands dimmed: the ticket list and the clock, and the card's own response
  const dims = () => ({ tickets: tickets.style.opacity, clock: clock.style.opacity, reply: reply.style.opacity });
  return { context, PIPE, style, dims, drawn, card, fit, set: v => Object.assign(context, v) };
}

test("it stands on the right, on the left when the box is there or the right has no room, and keeps its side", () => {
  const right = placer();
  right.context.pipePlace();
  assert.equal(right.PIPE.side, "right");
  assert.ok(parseFloat(right.style.left) > CARD.left + CARD.width, "right of the card");
  assert.deepEqual(right.dims(), { tickets: "", clock: "", reply: "0.1000" }, "the ticket list and the clock stay as they are; the card's response is down to a tenth");

  const left = placer({ box: true });
  left.context.pipePlace();
  assert.equal(left.PIPE.side, "left", "the card's box stands on the right");
  assert.ok(parseFloat(left.style.left) + parseFloat(left.style.width) < CARD.left, "left of the card, over the ticket list");
  assert.deepEqual(left.dims(), { tickets: "0.1000", clock: "0.1000", reply: "0.1000" }, "the ticket list and the clock down to a tenth too");

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
  assert.deepEqual(right.dims(), { tickets: "0.1000", clock: "0.1000", reply: "0.1000" });

  // no room either side: hidden where it is, nothing dimmed
  const none = placer({ roomRight: false, roomLeft: false });
  none.context.pipePlace();
  assert.equal(none.style.visibility, "hidden");
  assert.deepEqual(none.dims(), { tickets: "", clock: "", reply: "" });
  left.set({ magicRoom: () => null });
  left.context.pipePlace();
  assert.deepEqual(left.dims(), { tickets: "", clock: "", reply: "" }, "out and dimming, then its room gone: back as they were");
  // sinking back into the card, what it dims comes back as far as it has sunk
  const sinking = placer({ box: true });
  sinking.PIPE.rise.then = () => {};
  sinking.PIPE.rise.t = 0.5;
  sinking.context.pipePlace();
  assert.deepEqual(sinking.dims(), { tickets: "0.5500", clock: "0.5500", reply: "0.5500" });
});

test("its first line stands level with the card's own first line, and it reaches down to the box's foot at most, either side", () => {
  for (const box of [false, true]) {
    const at = placer({ box, want: 143, card: { first: 330, view: 243, pend: 600 } });
    const side = box ? "left" : "right";
    const whole = box ? MagicBox.place(CARD, { ...at.fit, left: at.fit.left }, null, "left") : MagicBox.place(CARD, at.fit);
    const foot = whole.top + whole.height;
    const place = () => { at.context.pipePlace(); return { top: parseFloat(at.style.top), height: parseFloat(at.style.height) }; };
    let p = place();
    assert.equal(at.PIPE.side, side);
    assert.ok(close(p.top + LEAD, 330), side + ": its first line level with the card's");
    assert.ok(p.top > whole.top + 100, side + ": well under the box's top, where it stood");
    assert.ok(close(p.height, 143), side + ": a short response as tall as its words from there");
    // the brace's top arm at the top of that line
    let [, drawnAt, drawnSide, , lead] = at.drawn.at(-1);
    assert.equal(drawnSide, side);
    assert.ok(close(drawnAt.top + lead, 330), side + ": the brace from the top of the first line");
    // a long response down to the box's foot, where its words scroll
    at.PIPE.view.want = () => ({ height: 2000 });
    p = place();
    assert.ok(close(p.top + LEAD, 330) && close(p.top + p.height, foot), side + ": a long one ends at the box's foot");
    // its words scrolled: it stands where it stood, and so does the brace
    at.PIPE.body.scrollTop = 120;
    p = place();
    [, drawnAt, , , lead] = at.drawn.at(-1);
    assert.ok(close(p.top + LEAD, 330) && close(drawnAt.top + lead, 330), side + ": its scroll moves neither");
    at.PIPE.body.scrollTop = 0;
    // the card's line moved, by a scroll, a longer title or the card's size: it follows
    at.card.first = 300;
    p = place();
    assert.ok(close(p.top + LEAD, 300) && close(p.top + p.height, foot), side + ": it follows the card's line");
    // that line scrolled up past the answer's top: it stays at the answer's top
    at.card.first = 100;
    assert.ok(close(place().top + LEAD, 243), side + ": held at the top of the card's answer");
    // down under the typing box: it stays a line over the typing box
    at.card.first = 700;
    assert.ok(close(place().top + LEAD, 600 - 23.5), side + ": held a line over the typing box");
    // sinking back into the card it keeps where it stood, as the answer goes back where it was read
    at.card.first = 330;
    place();
    at.PIPE.rise.then = () => {};
    at.card.first = 120;
    assert.ok(close(place().top + LEAD, 330), side + ": it sinks where it stood");
    at.PIPE.rise.then = null;
    assert.ok(close(place().top + LEAD, 243));
  }
  // on a board drawn smaller than its stage, in the stage's pixels it stands in
  const S = 0.87, sy = 20;
  const small = placer({ want: 143, S, sy, card: { first: sy + 330 * S, view: sy + 243 * S, pend: sy + 600 * S } });
  small.context.pipePlace();
  assert.ok(close(parseFloat(small.style.top) + LEAD, 330, 1e-9), "level on a smaller board");
  // a response with no words to stand level with stands as the box does
  const none = placer({ want: 143 });
  none.context.pipePlace();
  assert.ok(close(parseFloat(none.style.top), MagicBox.place(CARD, none.fit).top));
  assert.equal(none.drawn.at(-1)[4], null, "and its brace starts in by the corner");
  // gone, it keeps no place for the next
  assert.match(fn("pipeOff"), /PIPE\.top = null;/);
  // the card's answer scrolled moves it, as a change to the card does
  assert.match(HTML, /addEventListener\("scroll", e => \{\n    const el = PIPE\.id === null \? null : els\[PIPE\.id\];\n    if \(el && e\.target === el\.replyview && pipeShown\(\)\) pipePlace\(\);\n  \}, \{ capture: true, passive: true \}\);/);
});

// ---- coming and going ------------------------------------------------------------------
test("the response comes, rises and sinks by the magic box's own steps and curve, a little quicker than the box", () => {
  // both boxes on one clock, through the steps cut out of the page
  const clock = { t: 0 }, asked = new Map();
  let next = 1;
  const fake = () => {
    const cls = new Set();
    return { style: { props: {}, setProperty(k, v) { this.props[k] = v; }, visibility: "" },
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
        toggle: (c, yes = !cls.has(c)) => (yes ? cls.add(c) : cls.delete(c), yes) } };
  };
  const box = () => ({ el: fake(), line: { style: {} }, rise: { t: 1, dir: 0, fast: 1, raf: 0, last: 0, then: null } });
  const PIPE_MS = Number(cut("const PIPE_MS = ", ",").slice("const PIPE_MS = ".length));
  const RISE_MS = Number(cut("const RISE_MS = ", ",").slice("const RISE_MS = ".length));
  assert.ok(PIPE_MS >= 400 && PIPE_MS <= 0.7 * RISE_MS, `quicker than the box, and still a motion: ${PIPE_MS} against ${RISE_MS}`);
  assert.match(HTML, /ground: document\.getElementById\("pipeground"\), id: null, raw: null, ms: PIPE_MS,/);
  const MB = box(), PIPE = { ...box(), ground: { style: {} }, ms: PIPE_MS };
  const context = vm.createContext({ MB, PIPE, performance: { now: () => clock.t },
    requestAnimationFrame: cb => { asked.set(next, cb); return next++; }, cancelAnimationFrame: id => asked.delete(id) });
  vm.runInContext(cut("const RISE_MS = ", "\n") + "\n" + cut("function riseEase(", "\n") + "\n" +
    ["magicRiseSet", "magicRise", "magicRiseStep", "magicRiseStop", "boxCome", "boxRise", "boxBack", "boxSink"].map(fn).join(""), context);
  const ease = vm.runInContext("riseEase", context);
  const frame = () => { clock.t += 1000 / 60; const due = [...asked]; asked.clear(); for (const [, cb] of due) cb(clock.t); };
  const look = b => [b.el.style.props["--rise"], b.line.style.opacity, b.el.classList.contains("rising")];
  const at = (ms, i) => ease(Math.min(1, Math.max(0, i * (1000 / 60) / ms)));
  const on = (b, v) => Math.abs(Number(b.el.style.props["--rise"]) - v) < 2e-4;
  // new on the page: flat, then risen, each over its own time on the one curve
  for (const b of [MB, PIPE]) { context.boxCome(b, 0); b.el.classList.add("on"); context.boxRise(b); }
  assert.deepEqual(look(PIPE), ["0.0000", "0.0000", true]);
  for (let i = 1; i <= 70; i++) {
    frame();
    assert.ok(on(PIPE, at(PIPE_MS, i)), `frame ${i}`);
    assert.ok(on(MB, at(RISE_MS, i)), `the box, frame ${i}`);
    assert.equal(PIPE.line.style.opacity, PIPE.el.style.props["--rise"], "its brace with it");
    assert.equal(PIPE.ground.style.opacity, PIPE.el.style.props["--rise"], "the patch of board under it with it");
  }
  assert.deepEqual(look(MB), ["1.0000", "1.0000", false]);
  assert.deepEqual(look(PIPE), ["1.0000", "1.0000", false]);
  // put away: each sinks on the same curve over its own time and then goes
  const gone = { MB: -1, PIPE: -1 };
  let f = 0;
  context.boxSink(MB, () => { gone.MB = f; });
  context.boxSink(PIPE, () => { gone.PIPE = f; });
  for (f = 1; f <= 70; f++) {
    frame();
    if (gone.PIPE < 0) assert.ok(on(PIPE, at(PIPE_MS, PIPE_MS / (1000 / 60) - f)), `sinking, frame ${f}`);
  }
  const frames = ms => Math.ceil(ms / (1000 / 60));
  assert.ok(Math.abs(gone.PIPE - frames(PIPE_MS)) <= 1 && Math.abs(gone.MB - frames(RISE_MS)) <= 1, `each gone on its own time: ${JSON.stringify(gone)}`);
  // wanted again while it sinks, each rises back from where it is; one not on screen just goes
  for (const b of [MB, PIPE]) { b.rise.t = 1; context.boxSink(b, () => {}); }
  for (let i = 0; i < 12; i++) frame();
  const low = Number(PIPE.el.style.props["--rise"]);
  assert.ok(low > 0.3 && low < 1, "part way down");
  for (const b of [MB, PIPE]) context.boxBack(b);
  const back = [];
  for (let i = 0; i < 70; i++) { frame(); back.push(Number(PIPE.el.style.props["--rise"])); }
  assert.ok(back[0] >= low && back.every((v, i) => !i || v >= back[i - 1]) && back.at(-1) === 1, "back up from where it was");
  let off = 0;
  PIPE.el.style.visibility = "hidden";
  context.boxSink(PIPE, () => off++);
  assert.equal(off, 1, "hidden, it just goes");
  // and both paths go through those steps: the box's and the response's, and the response has no rise of its own
  assert.match(fn("magicLoad"), /boxCome\(MB, t\);/);
  assert.match(fn("magicPlace"), /boxRise\(MB\);/);
  assert.match(fn("magicSink"), /boxSink\(MB, magicOff\);/);
  assert.match(fn("magicSync"), /boxBack\(MB\);/);
  assert.match(fn("pipeSync"), /boxCome\(PIPE, 0\);[\s\S]*boxBack\(PIPE\);/);
  assert.match(fn("pipePlace"), /boxRise\(PIPE\);/);
  assert.match(fn("pipeSink"), /boxSink\(PIPE, pipeOff\);/);
  for (const name of ["pipeSync", "pipePlace", "pipeSink"])
    assert.ok(!/magicRise\(|magicRiseSet\(|"rising"/.test(fn(name)), name + " moves it by a step of its own");
});

test("the ticket list and the clock, piped left, and the card's own response go down to a tenth on the pipe's own frames, and back as it sinks", () => {
  const clock = { t: 0 }, asked = new Map();
  let next = 1;
  const cls = new Set();
  const style = () => ({ opacity: "" });
  const tickets = { style: style() }, clockbox = { style: style() }, reply = { style: style() }, other = { style: style() };
  const PIPE = { el: { style: { props: {}, setProperty(k, v) { this.props[k] = v; }, visibility: "" },
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
        toggle: (c, yes = !cls.has(c)) => (yes ? cls.add(c) : cls.delete(c), yes) } },
    line: { style: {} }, ground: { style: {} }, rise: { t: 1, dir: 0, fast: 1, raf: 0, last: 0, then: null },
    id: "c1", side: "left", aside: [tickets, clockbox], dimmed: null, dimAt: { reply: "", aside: "" } };
  const context = vm.createContext({ PIPE, MB: PIPE, els: { c1: { reply }, c2: { reply: other } }, performance: { now: () => clock.t },
    requestAnimationFrame: cb => { asked.set(next, cb); return next++; }, cancelAnimationFrame: id => asked.delete(id) });
  vm.runInContext(cut("const RISE_MS = ", "\n") + "\n" + cut("const PIPE_MS = ", "\n") + "\n" + cut("function riseEase(", "\n") + "\n" +
    ["magicRiseSet", "magicRise", "magicRiseStep", "magicRiseStop", "boxCome", "boxRise", "boxSink", "pipeDim"].map(fn).join(""), context);
  PIPE.ms = vm.runInContext("PIPE_MS", context);
  PIPE.dim = vm.runInContext("pipeDim", context);
  assert.equal(vm.runInContext("PIPE_DIM", context), 0.1);
  assert.match(HTML, /aside: \["tickets", "clockbox"\]\.map\(id => document\.getElementById\(id\)\)\.filter\(Boolean\), dim: pipeDim,/);
  const frame = () => { clock.t += 1000 / 60; const due = [...asked]; asked.clear(); for (const [, cb] of due) cb(clock.t); };
  // --rise is written to four places, as the dims are: the same within that
  const rise = () => Number(PIPE.el.style.props["--rise"]);
  const want = () => (rise() > 0 ? 1 - 0.9 * rise() : "");
  const dims = () => [tickets.style.opacity, clockbox.style.opacity, reply.style.opacity];
  const inStep = (got, what) => got.forEach(v => assert.ok(want() === "" ? v === "" || Number(v) > 0.9998 : Math.abs(Number(v) - want()) < 2e-4,
    what + ": " + got + " against " + want()));
  // coming: flat and nothing dimmed, then each frame of its rise the same share of the way to a tenth
  context.boxCome(PIPE, 0); cls.add("on"); context.boxRise(PIPE);
  assert.deepEqual(dims(), ["", "", ""], "nothing dimmed while it is flat");
  let frames = 0;
  while (asked.size) {
    frame(); frames++;
    inStep(dims(), `frame ${frames}`);
  }
  assert.ok(Math.abs(frames - PIPE.ms / (1000 / 60)) <= 1, "over the pipe's own time");
  assert.deepEqual(dims(), ["0.1000", "0.1000", "0.1000"], "risen: a tenth");
  // going: back the same way, frame for frame, and nothing left dimmed once it is off
  context.boxSink(PIPE, () => { cls.delete("on"); context.magicRiseSet(1, PIPE); });
  const seen = [];
  while (asked.size) { frame(); if (cls.has("on")) { inStep(dims(), "sinking"); seen.push(Number(reply.style.opacity || 1)); } }
  assert.ok(seen.length > 20 && seen.every((v, i) => !i || v >= seen[i - 1]), "coming back up, never down");
  assert.deepEqual(dims(), ["", "", ""], "off: all as they were");
  // piped right, the ticket list and the clock are left alone and only the response dims
  PIPE.side = "right";
  context.boxCome(PIPE, 0); cls.add("on"); context.boxRise(PIPE);
  while (asked.size) frame();
  assert.deepEqual(dims(), ["", "", "0.1000"]);
  // another card's response out: the first card's comes back whole
  PIPE.id = "c2";
  context.pipeDim();
  assert.deepEqual([reply.style.opacity, other.style.opacity], ["", "0.1000"]);
  // and a placing that changes nothing writes nothing
  other.style = { set opacity(v) { throw new Error("written again: " + v); }, get opacity() { return "0.1"; } };
  context.pipeDim();
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
test("it is a second magic box on the box's own rules, always whole, its shadow on its top and foot only, with no edge and no bar", () => {
  const style = HTML.slice(0, HTML.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = sel => {
    const found = style.match(new RegExp("\\n  " + sel.replace(/[.()*>:]/g, "\\$&") + "\\{([^}]*)\\}"));
    assert.ok(found, "no rule " + sel);
    return found[1];
  };
  // every rule that places and dresses the box is the pipe's too, word for word
  const both = ":is(#magicbox, #pipebox)";
  for (const sel of [both, "body.focus " + both + ".on", both + ".held", "body.lowered " + both + ".on"]) rule(sel);
  assert.ok(style.includes("\n  :is(#magicbox, #pipebox){background:var(--card); border:var(--edge) solid var(--line); border-radius:var(--mb-round);"));
  assert.match(rule(both + ".held"), /opacity:1/);
  // the box's look as it rises is the box's alone
  for (const sel of ["#magicbox.rising", "#magicbox.rising.held", "#magicbox.rising > *"]) rule(sel);
  assert.match(rule("#magicbox.rising > *"), /^opacity:var\(--rise\)$/);
  assert.ok(!/#pipebox\)?\.rising(\.held)? > \*|:is\(#magicbox, #pipebox\)\.rising/.test(style), "nothing of the box's rise is the pipe's");
  // its own rules: its look, whole, its shadow, and its rise as a whole
  const own = style.match(/\n  #pipebox[^{]*\{[^}]*\}/g) || [];
  assert.deepEqual(own.map(r => r.trim().split("{")[0]), ["#pipebox, #pipebox.rising", "#pipebox", "#pipebox.held",
    "#pipebox.rising", "#pipebox .mbbar", "#pipebox, #pipebox *", "#pipebox::-webkit-scrollbar, #pipebox *::-webkit-scrollbar",
    "#pipebox .mbbody", "#pipebox .mbtext", "#pipebox .mbtext[contenteditable]"]);
  assert.match(rule("#pipebox"), /^opacity:1;/, "never faded as the box is while the card holds the keys");
  // and no edge on its sides: its face the board's own paper, whatever colour the board is
  assert.match(rule("#pipebox"), /^opacity:1; background:var\(--paper\);/);
  assert.match(HTML, /document\.body\.style\.setProperty\("--paper", pick\.value\);/, "the board's colour is the paper's");
  assert.equal(rule("#pipebox.rising"), "--rise:0; transition:none; opacity:var(--rise)", "it comes and goes as a whole on the box's --rise");
  assert.ok(!own.join("").match(/transform|--shade-unselected/), "no motion or fade of its own");
  // its shadow: the box's own two, each layer pulled in at the sides by half again its blur,
  // so not even the blur's tail reaches past a side, and reaching past the top and the foot as far as the box's
  const layers = text => text.split(/,\s*(?![^(]*\))/).map(l => {
    const n = l.trim().match(/^0 (-?[\d.]+)(?:px)? ([\d.]+)px(?: (-?[\d.]+)px)? rgba\(60,45,20,(\.\d+)\)$/);
    assert.ok(n, "a layer " + l);
    return { y: +n[1], blur: +n[2], spread: +(n[3] || 0), a: n[4] };
  });
  const vars = style.match(/\n  body\.focus\{--shade-raised:([^;]*);\s*--shade-lighter:([^;]*);/);
  const reach = ls => ({ top: Math.max(...ls.map(l => l.blur + l.spread - l.y)), foot: Math.max(...ls.map(l => l.blur + l.spread + l.y)),
    side: Math.max(...ls.map(l => l.blur + l.spread)) });
  for (const [mine, box] of [[rule("#pipebox"), vars[2]], [rule("#pipebox.held"), vars[1]]]) {
    const ls = layers(mine.match(/box-shadow:([^;]*)$/)[1]), theirs = layers(box);
    assert.equal(ls.length, 4, "a layer for the top and one for the foot, for each of the box's two");
    assert.ok(reach(ls).side <= 0 && ls.every(l => l.blur + l.spread <= -l.blur / 2), "nothing past the sides");
    assert.ok(close(reach(ls).top, reach(theirs).top) && close(reach(ls).foot, reach(theirs).foot), "as far past the top and the foot as the box's");
    for (const l of theirs) assert.equal(ls.filter(m => m.blur === l.blur && m.a === l.a).length, 2, "each of the box's layers, at its blur and strength");
  }
  // no edge: the box's, kept clear in both its states, so it measures as the box does
  assert.equal(rule("#pipebox, #pipebox.rising"), "border-color:transparent");
  assert.equal(rule("#pipebox .mbbar"), "display:none");
  // the sheet's words, which fade at both ends of their scroll (--upband, --downband)
  assert.match(HTML, /<section id="pipebox" class="magicbox"/);
  assert.match(read("card-tokens.css"), /\.magicbox \.mbbody:is\(\[data-kind="text"\], \[data-kind="markdown"\]\)\{\s*-webkit-mask-image:linear-gradient\(to bottom,/);
  assert.match(fn("pipeDraw"), /PIPE\.view\.draw\(\{ kind: "markdown", text: raw \}\);/);
  // held, it is held as the box is
  assert.match(fn("pipeHold"), /PIPE\.el\.classList\.toggle\("held", on\);/);
  assert.match(fn("pipeHeld"), /PIPE\.el\.classList\.contains\("held"\)/);
  // the patch of the board under it: the board's own paper in its shape, under it
  // and over the ticket list, coming with its rise and placed with it
  assert.ok(HTML.indexOf('<div id="pipeground"') < HTML.indexOf('<section id="pipebox"'), "beneath it on the page");
  assert.match(rule("body.focus #pipeground.on"), /position:fixed; z-index:1;[^}]*background:var\(--paper\); border-radius:var\(--mb-round\)/);
  assert.match(fn("magicRiseSet"), /if \(box\.ground\) box\.ground\.style\.opacity = p\.toFixed\(4\);/);
  assert.match(fn("pipePlace"), /Object\.assign\(PIPE\.el\.style, rect, \{ visibility: "" \}\);[\s\S]*Object\.assign\(PIPE\.ground\.style, rect\); PIPE\.ground\.classList\.add\("on"\);/);
  assert.match(fn("pipeOff"), /PIPE\.ground\.classList\.remove\("on"\)/);
  // the brace wears the box's lines' shadow and sits beneath the card
  assert.match(style, /\n  body\.focus #pipeline\.on > g\{filter:drop-shadow\(0 2px 9px rgba\(60,45,20,\.18\)\) drop-shadow\(0 1px 1\.5px rgba\(60,45,20,\.10\)\)\}/);
  assert.ok(HTML.indexOf('<svg id="pipeline"') < HTML.indexOf("<main>"));
  // what it dims, the ticket list and the clock piped left and the card's response,
  // is dimmed on its own frames (pipeDim), with no fade or easing of the sheet's own over it
  assert.ok(!/:is\(#tickets, #clockbox\)\{|pipeleft/.test(style), "the ticket list and the clock have a fade of their own");
  assert.match(fn("magicRiseSet"), /if \(box\.dim\) box\.dim\(p\);/);
  // the card settles while it holds the keys, as for the box, at the same weight
  assert.ok(style.includes("\n  body.focus:not(.home, .editmode):where(.pipekeys) main{box-shadow:var(--shade-lighter); opacity:var(--shade-unselected)}"));
  // its words are selectable, as the box's are
  assert.match(style, /#magicbox \.mbtext, #pipebox \.mbtext,/);
  // no accent and no purple anywhere it is dressed
  const dressed = (style.match(/\n  [^\n{]*#pipe(box|line|ground)[^{]*\{[^}]*\}/g) || []).join("");
  assert.ok(dressed.length > 200 && !/accent|purple|#[0-9a-f]{3,8}\b/i.test(dressed));
});

// ---- the phone --------------------------------------------------------------------------
test("the phone page keeps one step and pipes nothing, and neither does the Mac's phone view", () => {
  const phone = read("m.html");
  for (const name of ["pipebox", "pipeline", "pipeground", "pipeStep", "pipeSync", "cardAnswerOff", "row-box", "tallrow", "rowRise"])
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
