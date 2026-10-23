// The graph of the links between cards, its logic without a page: graph.js is
// loaded on its own in a bare context, with no document and no window, and
// LinkGraph.logic is checked on a small made-up /links/all answer: the model
// of cards and links, the local graph's neighbours at each depth, what each
// replay step shows, the colours by lane and by section, the dots' sizes, the
// timeline's rows and span, the axis's marks, the find box and the times as
// the sheet writes them.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const context = vm.createContext({});
vm.runInContext(readFileSync(path.join(ROOT, "graph.js"), "utf8"), context, { filename: "graph.js" });
const L = context.LinkGraph.logic;
const ids = set => [...set].sort();
// what the file builds is built in its own context, with its own Array, so it
// is compared as plain data
const plain = v => JSON.parse(JSON.stringify(v));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

const DAY = 86400;
const T0 = Date.UTC(2026, 8, 14, 15, 0) / 1000;   // Mon Sep 14 2026, 15:00 UTC
const card = (id, owner, section, made, changed, extra = {}) =>
  ({ id, title: "Card " + id, owner, section, made, changed, branch: null, status: null, ...extra });
// a plan made on day 0, its phase one on day 3 and results on day 9 in another
// lane, a side idea, and a card in a third lane the board names nowhere
const ANSWER = {
  now: T0 + 20 * DAY,
  cards: [
    card("m1", "facilitator", "done", T0, T0 + 4 * DAY),
    card("m2", "facilitator", "doing", T0 + 3 * DAY, T0 + 10 * DAY,
      { branch: { value: "v0/phase-one", ts: T0, agent: "claude" }, status: { value: "building", ts: T0, agent: "claude" } }),
    card("m3", "parasail", "docked", T0 + 9 * DAY, T0 + 12 * DAY),
    card("m4", "parasail", "deferred", T0 + 1 * DAY, T0 + 2 * DAY),
    card("m5", "zebra", "doing", null, null),
    card("m5", "zebra", "doing", null, null),                     // a card twice is kept once
  ],
  links: [
    { from: "m2", to: "m1", ts: T0 + 3 * DAY + 60, agent: "claude" },
    { from: "m4", to: "m1", ts: T0 + 3 * DAY + 120, agent: "codex" },
    { from: "m3", to: "m2", ts: T0 + 9 * DAY + 60, agent: "claude" },
    { from: "m1", to: "m2", ts: T0 + 9 * DAY + 90, agent: "" },   // the reverse of the first
    { from: "m3", to: "m2", ts: T0 + 9 * DAY + 95, agent: "claude" },   // made twice: kept once
    { from: "m5", to: "m3", ts: 0, agent: "claude" },               // a link with no good time
    { from: "m2", to: "m2", ts: T0, agent: "claude" },             // to itself: dropped
    { from: "m9", to: "m1", ts: T0, agent: "claude" },             // a card not in the answer: dropped
  ],
};
const LANES = [{ id: "parasail", name: "Parasail" }, { id: "facilitator", name: "facilitator" }, { id: "unused", name: "Unused" }];
const M = L.model(ANSWER, LANES);

test("the file loads with no page at all and touches nothing of one", () => {
  assert.equal(typeof context.LinkGraph.open, "function");
  assert.equal(typeof context.document, "undefined");
  assert.equal(typeof context.d3, "undefined", "the logic needs no d3");
});

test("the model counts each card's links both ways and keeps each link once, oldest first", () => {
  same(M.nodes.map(n => n.id), ["m1", "m2", "m3", "m4", "m5"]);
  same(M.edges.map(e => [e.from, e.to, e.step]),
    [["m2", "m1", 1], ["m4", "m1", 2], ["m3", "m2", 3], ["m1", "m2", 4], ["m5", "m3", 5]]);
  const n = id => M.byId.get(id);
  same([n("m1").out, n("m1").in, n("m1").degree], [1, 2, 3]);
  same([n("m2").out, n("m2").in, n("m2").degree], [1, 2, 3]);
  same([n("m5").out, n("m5").in], [1, 0]);
  same(M.edges.map(e => e.mutual), [true, false, false, true, false], "a link whose reverse is there too");
  assert.equal(n("m4").first, T0 + 3 * DAY + 120, "a card's first link is the oldest at either end of it");
  assert.equal(n("m4").firstStep, 2);
  assert.equal(n("m3").firstStep, 3);
  assert.equal(n("m2").branch, "v0/phase-one");
  assert.equal(n("m2").status, "building");
  assert.equal(n("m1").branch, "");
});

test("a link with no good time is drawn at the later of its cards' made times, or nowhere", () => {
  const broken = M.edges.find(e => e.from === "m5");
  assert.equal(broken.ts, null);
  assert.equal(broken.at, T0 + 9 * DAY, "m3's made time, since m5 has none");
  const bare = L.model({ cards: [card("a", "x", "doing", null, null), card("b", "x", "doing", null, null)],
    links: [{ from: "a", to: "b", ts: "soon" }] });
  assert.equal(bare.edges[0].at, null);
  assert.equal(bare.nodes[0].section, "doing");
  const odd = L.model({ cards: [{ id: "c", section: "elsewhere" }], links: [] });
  same([odd.nodes[0].section, odd.nodes[0].owner, odd.nodes[0].title], ["doing", "facilitator", ""]);
  same(L.model(null).nodes, [], "no answer is an empty model");
});

test("the lanes follow the board's tab order, then the lanes it does not name, each with its own colour", () => {
  same(M.lanes.map(l => [l.id, l.name]), [["parasail", "Parasail"], ["facilitator", "facilitator"], ["zebra", "zebra"]]);
  same(M.lanes.map(l => l.colour), L.LANE_COLOURS.slice(0, 3));
  assert.equal(L.colourOf(M.byId.get("m3"), "lane", M), L.LANE_COLOURS[0]);
  assert.equal(L.colourOf(M.byId.get("m2"), "section", M), L.SECTION_COLOURS.doing);
  assert.equal(L.colourOf(M.byId.get("m1"), "section", M), L.SECTION_COLOURS.done);
});

test("lanes past the palette's end still get colours of their own, and none is purple", () => {
  const colours = Array.from({ length: 24 }, (_, i) => L.laneColour(i));
  assert.equal(new Set(colours).size, 24, "24 lanes, 24 colours");
  for (const hex of [...colours, ...Object.values(L.SECTION_COLOURS)]){
    assert.match(hex, /^#[0-9a-f]{6}$/i, hex);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 0.08) continue;
    const hue = max === r ? 60 * (((g - b) / (max - min)) % 6) : max === g ? 60 * ((b - r) / (max - min) + 2) : 60 * ((r - g) / (max - min) + 4);
    const h = (hue + 360) % 360;
    assert.ok(h < 250 || h > 330, `${hex} is no purple (hue ${h.toFixed(0)})`);
  }
});

test("the local graph's cards are those within the depth, links followed either way", () => {
  same(ids(L.neighbours(M, "m4", 1)), ["m1", "m4"]);
  same(ids(L.neighbours(M, "m4", 2)), ["m1", "m2", "m4"]);
  same(ids(L.neighbours(M, "m4", 3)), ["m1", "m2", "m3", "m4"]);
  same(ids(L.neighbours(M, "m3", 1)), ["m2", "m3", "m5"], "a link reaching the card counts as one leaving it");
  same(ids(L.neighbours(M, "m9", 2)), [], "a card with no links has no graph");
  const local = L.neighbours(M, "m4", 2);
  same(L.within(M, local).map(e => e.step), [1, 2, 4], "the links among them, oldest first");
  assert.equal(L.within(M, null).length, M.edges.length);
});

test("a replay step shows that many links in order, and the cards they touch", () => {
  const none = L.upTo(M.edges, 0);
  same([none.edges.length, none.ids.size, none.last], [0, 0, null]);
  const two = L.upTo(M.edges, 2);
  same(two.edges.map(e => e.step), [1, 2]);
  same(ids(two.ids), ["m1", "m2", "m4"]);
  assert.equal(two.last.step, 2);
  assert.equal(L.upTo(M.edges, 99).edges.length, 5, "past the end is all of them");
  assert.equal(L.upTo(M.edges, -3).edges.length, 0);
});

test("a dot grows with its links and stays within its bounds", () => {
  let last = 0;
  for (const d of [0, 1, 2, 4, 9, 30, 400]){
    const r = L.radius(d);
    assert.ok(r >= last, `degree ${d}`);
    assert.ok(r >= 3 && r <= 14, `degree ${d}: ${r}`);
    last = r;
  }
  assert.equal(L.radius(-1), L.radius(0));
});

test("the timeline's rows run oldest made first and its span covers every card and link", () => {
  const T = L.timeline(M, null);
  same(T.rows.map(n => n.id), ["m1", "m4", "m2", "m3", "m5"], "made order; a card with no made time by its first link");
  same(T.arcs.map(a => [a.edge.step, a.a, a.b]), [[1, 2, 0], [2, 1, 0], [3, 3, 2], [4, 0, 2], [5, 4, 3]]);
  assert.ok(T.t0 < T0 && T.t1 > T0 + 12 * DAY, "made, changed and link times are all inside");
  const span = 12 * DAY;
  assert.ok(Math.abs((T0 - T.t0) - span * 0.03) < 1, "padded by three percent");
  const local = L.timeline(M, L.neighbours(M, "m4", 1));
  same(local.rows.map(n => n.id), ["m1", "m4"]);
  same(local.arcs.map(a => a.edge.step), [2]);
  const one = L.model({ cards: [card("a", "x", "doing", T0, T0)], links: [] });
  const T1 = L.timeline(one, null);
  assert.ok(T1.t1 - T1.t0 >= 3600, "never under an hour across");
  const timeless = L.timeline(L.model({ now: T0, cards: [card("a", "x", "doing", null, null)], links: [] }), null);
  assert.ok(timeless.t1 > timeless.t0 && timeless.t1 >= T0, "a set with no times at all still has a span");
});

test("the axis's marks are at least the gap apart and fall on hours, days, Mondays and months", () => {
  const cases = [[T0, T0 + DAY, 1200, "h"], [T0, T0 + 10 * DAY, 1000, "d"], [T0, T0 + 70 * DAY, 1000, "w"],
    [T0, T0 + 400 * DAY, 900, "m"], [T0, T0 + 3000 * DAY, 600, "y"]];
  for (const [a, b, px, unit] of cases){
    const out = L.ticks(a, b, px);
    assert.equal(out.unit, unit, `${(b - a) / DAY} days over ${px}px`);
    assert.ok(out.ticks.length >= 2, unit);
    const per = (b - a) / px;
    for (let i = 1; i < out.ticks.length; i++)
      assert.ok((out.ticks[i].t - out.ticks[i - 1].t) / per >= 84 * 0.95, `${unit}: marks are apart`);
    for (const t of out.ticks){
      assert.ok(t.t >= a && t.t <= b, "inside the span");
      const d = new Date(t.t * 1000);
      assert.equal(d.getMinutes(), 0, unit);
      if (unit !== "h") assert.equal(d.getHours(), 0, `${unit} marks start a day`);
      if (unit === "w") assert.equal(d.getDay(), 1, "weeks start on a Monday");
      if (unit === "m" || unit === "y") assert.equal(d.getDate(), 1, "months start on the first");
      if (unit === "d" || unit === "w") assert.match(t.label, /^[A-Z][a-z]{2} \d{1,2}$/, t.label);
    }
  }
  const months = L.ticks(Date.UTC(2026, 10, 1) / 1000, Date.UTC(2027, 3, 1) / 1000, 900).ticks;
  assert.ok(months.some(t => t.label === "Jan 2027" && t.major), "the year's first month names the year");
});

test("the find box wants every word somewhere in the title, the number or the lane", () => {
  const n = { id: "m584", title: "Backlinks between cards", owner: "facilitator" };
  assert.equal(L.matches(n, ""), true);
  assert.equal(L.matches(n, "   "), true);
  assert.equal(L.matches(n, "backlinks"), true);
  assert.equal(L.matches(n, "CARDS between"), true);
  assert.equal(L.matches(n, "584"), true);
  assert.equal(L.matches(n, "m584"), true);
  assert.equal(L.matches(n, "facil"), true, "the lane's id");
  assert.equal(L.matches(n, "para", "Parasail"), true, "the lane's name");
  assert.equal(L.matches(n, "backlinks graph"), false, "every word, not any");
  assert.equal(L.number("m584"), "584");
  assert.equal(L.number("1.1"), "1.1");
});

test("times are written as the sheet writes them, with the year only when it is not now's", () => {
  const at = new Date(2026, 9, 3, 14, 20).getTime() / 1000;
  const now = new Date(2026, 9, 18, 9, 0).getTime() / 1000;
  assert.equal(L.when(at, now), "Oct 3, 2:20 pm");
  assert.equal(L.when(new Date(2026, 9, 3, 0, 5).getTime() / 1000, now), "Oct 3, 12:05 am");
  assert.equal(L.when(new Date(2025, 11, 31, 23, 59).getTime() / 1000, now), "Dec 31 2025, 11:59 pm");
  assert.equal(L.day(at, now), "Oct 3");
  assert.equal(L.when(null), "an unknown time");
  assert.equal(L.day(0), "an unknown day");
});
