// Every link at once, over real HTTP on a copied board on free ports: GET
// /links/all answers every link whose two cards are on the board, oldest first,
// and every card at either end of one, with its properties read the way /props
// reads them, made and changed included, in one reading. A card in the Bin and
// its links are in no reading until a restore. Reading stores nothing.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

let board;
before(async () => { board = await startBoard(); });
after(async () => { if (board) await board.stop(); });

async function call(method, route, body) {
  const r = await board.call(method, route, body);
  let json;
  try { json = JSON.parse(r.text); } catch { json = r.text; }
  return { status: r.status, body: json };
}
async function post(route, body = "") {
  const r = await call("POST", route, body);
  assert.equal(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function get(route) {
  const r = await call("GET", route);
  assert.equal(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const statePath = () => path.join(board.data, "state.json");
const transcriptPath = () => path.join(board.data, "transcript.jsonl");
const saved = async () => JSON.parse(await readFile(statePath(), "utf8"));
const make = async (title, owner = "facilitator") => (await post(`/create?owner=${owner}`, title)).id;
const all = () => get("/links/all");
const pairs = list => list.map(l => [l.from, l.to]);
const ids = list => list.map(c => c.id);

test("a board with no links answers empty lists and the board's clock", async () => {
  const was = Date.now() / 1000;
  const read = await all();
  assert.deepEqual(Object.keys(read), ["now", "cards", "links"]);
  assert.deepEqual(read.cards, []);
  assert.deepEqual(read.links, []);
  assert.ok(read.now >= was - 1 && read.now <= Date.now() / 1000 + 1, "now is the board's time");
});

test("every link oldest first and every card it touches, across lanes, each card as /props reads it", async () => {
  const a = await make("All links: the plan");
  const b = await make("All links: phase one");
  const c = await make("All links: results");
  const lone = await make("All links: never linked");
  const lane = "1.1";   // the seed's card in another lane
  const first = await post(`/link?from=${b}&to=${a}&agent=claude`);
  const second = await post(`/link?from=${c}&to=${b}&agent=codex`);
  const third = await post(`/link?from=${lane}&to=${a}`);
  await post(`/props?box=${b}&branch=v0/phase-one&status=building&agent=claude`);
  await post(`/done?box=${a}&v=1`);

  const read = await all();
  assert.deepEqual(read.links, [
    { from: b, to: a, ts: first.ts, agent: "claude" },
    { from: c, to: b, ts: second.ts, agent: "codex" },
    { from: lane, to: a, ts: third.ts, agent: "" },
  ], "oldest first, each with when and by whom");
  const order = (await saved()).boxes.map(x => x.id).filter(id => [a, b, c, lane].includes(id));
  assert.deepEqual(ids(read.cards), order, "the cards in board order");
  assert.ok(!ids(read.cards).includes(lone), "a card with no link is not in it");
  for (const card of read.cards) {
    assert.deepEqual(Object.keys(card), ["id", "title", "owner", "section", "made", "changed", "branch", "status"]);
    assert.deepEqual(card, await get(`/props?box=${card.id}`), `${card.id} reads as /props reads it`);
  }
  const byId = Object.fromEntries(read.cards.map(x => [x.id, x]));
  assert.equal(byId[a].section, "done", "the section as it is now");
  assert.equal(byId[lane].owner, "pastureland", "a link may join cards of different lanes");
  assert.equal(byId[b].branch.value, "v0/phase-one");
  assert.equal(byId[b].status.value, "building");
  assert.equal(byId[c].branch, null);
});

test("renaming a card or moving it reads as it is now, and an unlink leaves the reading", async () => {
  const a = await make("Renamed: before");
  const b = await make("Renamed: other");
  await post(`/link?from=${a}&to=${b}&agent=claude`);
  await post(`/title?box=${a}`, "Renamed: after");
  await post(`/park?box=${b}&v=1`);
  let read = await all();
  const byId = Object.fromEntries(read.cards.map(x => [x.id, x]));
  assert.equal(byId[a].title, "Renamed: after");
  assert.equal(byId[b].section, "deferred");
  await post(`/unlink?from=${a}&to=${b}&agent=claude`);
  read = await all();
  assert.ok(!pairs(read.links).some(([f, t]) => f === a && t === b));
  assert.ok(!ids(read.cards).includes(a) && !ids(read.cards).includes(b), "with no link left neither card is in it");
});

test("a card in the Bin and its links are in no reading, and come back with a restore", async () => {
  const a = await make("Bin: points at it");
  const binned = await make("Bin: goes in");
  const b = await make("Bin: pointed at by it");
  await post(`/link?from=${a}&to=${binned}&agent=claude`);
  await post(`/link?from=${binned}&to=${b}&agent=claude`);
  const before = await all();
  await post(`/bin?box=${binned}`);
  const during = await all();
  assert.ok(!ids(during.cards).includes(binned));
  assert.ok(!pairs(during.links).some(([f, t]) => f === binned || t === binned));
  assert.ok(!ids(during.cards).includes(a) && !ids(during.cards).includes(b),
    "a card linked only with the binned one is out too");
  await post(`/bin/restore?box=${binned}`);
  const back = await all();
  assert.deepEqual(back.links, before.links, "every link back as it was");
  assert.deepEqual(ids(back.cards), ids(before.cards));
});

test("a reading stores nothing: no save, no transcript row", async () => {
  const a = await make("Reading: from");
  const b = await make("Reading: to");
  await post(`/link?from=${a}&to=${b}&agent=claude`);
  const rev = (await saved()).rev;
  const transcript = await readFile(transcriptPath(), "utf8");
  for (let i = 0; i < 3; i++) await all();
  assert.equal((await saved()).rev, rev);
  assert.equal(await readFile(transcriptPath(), "utf8"), transcript);
  for (const route of ["/state", "/m/state"]) {
    const shown = (await get(route)).boxes.find(x => x.id === a);
    assert.ok(!("links" in shown), `${route} still carries no links`);
  }
});

test("the times of seed cards, a project's first card and an id used again are /props's own", async () => {
  // a new project's first card is made with the project's row, not a create row
  const project = await post("/project?name=links-all-lane", homedir());
  const omni = (await saved()).boxes.find(x => x.owner === project.id).id;
  const a = await make("Times: linked to the seed");
  await post(`/link?from=${a}&to=0&agent=claude`);
  await post(`/link?from=${omni}&to=${a}&agent=claude`);
  await post(`/send?box=${omni}`, "a message on the project's first card");
  // an older board made and deleted another card under the seed card's id
  await board.restart(async () => {
    const early = 1700000000.5;
    const old = [{ ts: early - 100, kind: "create", box: "0", text: "an older card" },
      { ts: early - 50, kind: "delete", box: "0", text: "an older card" }]
      .map(r => JSON.stringify(r) + "\n").join("");
    await writeFile(transcriptPath(), old + await readFile(transcriptPath(), "utf8"));
  });
  const read = await all();
  for (const id of ["0", omni, a]) {
    const card = read.cards.find(x => x.id === id);
    assert.ok(card, `${id} is in the reading`);
    const props = await get(`/props?box=${id}`);
    assert.deepEqual([card.made, card.changed], [props.made, props.changed], id);
    assert.equal(typeof card.made, "number", id);
  }
  const seed = (await saved()).boxes.find(x => x.id === "0");
  assert.equal(read.cards.find(x => x.id === "0").made, seed.ts, "the rows of the older card under its id are not its own");
});

test("a link to a card that is not there, or with a broken time, is read safely; a tie keeps board order", async () => {
  const a = await make("Broken: first in order");
  const b = await make("Broken: second in order");
  const c = await make("Broken: target");
  await post(`/link?from=${a}&to=${c}&agent=claude`);
  await post(`/link?from=${b}&to=${c}&agent=claude`);
  const tie = 1790000000.25;
  await board.restart(async () => {
    const state = await saved();
    const box = id => state.boxes.find(x => x.id === id);
    box(a).links[0].ts = tie;
    box(b).links[0].ts = tie;
    box(b).links.push({ to: "m99999", ts: tie, agent: "claude" });   // left behind by a hand edit
    box(c).links = [{ to: a, ts: "yesterday", agent: 7 }];
    await writeFile(statePath(), JSON.stringify(state));
  });
  const read = await all();
  const mine = read.links.filter(l => [a, b, c].includes(l.from));
  assert.deepEqual(mine.filter(l => l.ts === tie).map(l => l.from), [a, b], "a tie keeps board order");
  assert.ok(!read.links.some(l => l.to === "m99999"), "a link to a card not on the board is left out");
  assert.ok(!read.cards.some(x => x.id === "m99999"));
  const broken = mine.find(l => l.from === c);
  assert.equal(broken.ts, 0, "a time that is not a number reads as 0");
  assert.equal(broken.agent, "", "an agent that is not a name reads as none");
  assert.deepEqual(read.links[0], broken, "and so it sorts first");
});
