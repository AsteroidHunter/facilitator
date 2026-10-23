// Links between cards, over real HTTP on a copied board on free ports: an agent
// links one card to another with /link, takes a link away with /unlink and reads
// a card's links both ways with /links. Each link is kept on the card it starts
// from with when it was made and by which agent, is written to the transcript,
// survives a restart, stays as it is through a rename or a move between
// sections, waits in the Bin with its card and goes when either card is deleted
// for good. A board saved before links loads exactly as it was.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { chmod, readFile, writeFile } = require("node:fs/promises");
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
const saved = async () => JSON.parse(await readFile(statePath(), "utf8"));
const card = async id => (await saved()).boxes.find(b => b.id === id);
const rows = async () => (await readFile(path.join(board.data, "transcript.jsonl"), "utf8"))
  .split("\n").filter(Boolean).map(line => JSON.parse(line));
const linkRows = async () => (await rows()).filter(r => r.kind === "link" || r.kind === "unlink");
const make = async title => (await post("/create?owner=facilitator", title)).id;
const links = id => get(`/links?box=${id}`);
const ids = list => list.map(row => row.id);

test("a link is kept on the card it starts from and read back both ways, across lanes", async () => {
  const a = await make("Continues the graph work");
  const b = await make("The graph work");
  const lane = "1.1";   // the seed's card in another lane
  const was = Date.now() / 1000;

  const made = await post(`/link?from=${a}&to=${b}&agent=claude`);
  assert.equal(made.ok, true);
  assert.equal(made.added, true);
  assert.equal(made.from, a);
  assert.equal(made.to, b);
  assert.equal(made.agent, "claude");
  assert.ok(made.ts >= was - 1 && made.ts <= Date.now() / 1000 + 1, "it carries the time it was made");
  await post(`/link?from=${lane}&to=${a}&agent=codex`);

  const fromA = await links(a);
  assert.equal(fromA.box, a);
  assert.equal(fromA.title, "Continues the graph work");
  assert.deepEqual(fromA.links, [{ id: b, title: "The graph work", owner: "facilitator",
    section: "doing", ts: made.ts, agent: "claude" }]);
  assert.equal(fromA.backlinks.length, 1);
  assert.equal(fromA.backlinks[0].id, lane);
  assert.equal(fromA.backlinks[0].owner, "pastureland", "a link may join cards of different lanes");
  assert.equal(fromA.backlinks[0].agent, "codex");
  const toB = await links(b);
  assert.deepEqual(toB.links, []);
  assert.deepEqual(ids(toB.backlinks), [a], "the card linked to sees who links to it");
  assert.deepEqual((await links(lane)).links.map(r => [r.id, r.owner]), [[a, "facilitator"]]);

  assert.deepEqual((await card(a)).links, [{ to: b, ts: made.ts, agent: "claude" }], "saved on the card it starts from");
  assert.ok(!("links" in (await card(b))), "the card linked to stores nothing");
  const row = (await linkRows()).find(r => r.kind === "link" && r.box === a);
  assert.equal(row.to, b);
  assert.equal(row.agent, "claude");
  assert.equal(typeof row.ts, "number");
  assert.deepEqual((await get(`/thread?box=${a}`)).messages, [], "the card's thread is untouched");

  // the board's readings are what they were: nothing on screen changes yet
  for (const route of ["/state", "/m/state"]) {
    const shown = (await get(route)).boxes.find(x => x.id === a);
    assert.ok(!("links" in shown), `${route} carries no links`);
  }
});

test("a link made twice is kept once, and the reverse link is its own", async () => {
  const a = await make("Twice from here");
  const b = await make("Twice to here");
  const first = await post(`/link?from=${a}&to=${b}&agent=claude`);
  const rev = (await saved()).rev;
  const again = await post(`/link?from=${a}&to=${b}&agent=codex`);
  assert.equal(again.ok, true);
  assert.equal(again.added, false, "the second asks for a link already there");
  assert.equal(again.ts, first.ts, "the first time it was made stands");
  assert.equal(again.agent, "claude", "and so does the agent that made it");
  assert.equal((await saved()).rev, rev, "nothing is saved again");
  assert.equal((await card(a)).links.length, 1);
  assert.equal((await linkRows()).filter(r => r.kind === "link" && r.box === a).length, 1, "one transcript row");

  const back = await post(`/link?from=${b}&to=${a}`);
  assert.equal(back.added, true);
  assert.equal(back.agent, "", "no agent named is an empty name");
  const fromA = await links(a);
  assert.deepEqual(ids(fromA.links), [b]);
  assert.deepEqual(ids(fromA.backlinks), [b]);
});

test("a link to itself, to a card that is not there or without both ends is refused", async () => {
  const a = await make("Refusals start here");
  const rev = (await saved()).rev;
  const self = await call("POST", `/link?from=${a}&to=${a}`);
  assert.equal(self.status, 400);
  assert.equal(self.body.error, "a card cannot link to itself");
  const missing = await call("POST", `/link?from=${a}&to=m99999`);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "no card m99999 on the board");
  assert.equal((await call("POST", `/link?from=m99999&to=${a}`)).body.error, "no card m99999 on the board");
  for (const route of [`/link?from=${a}`, `/link?to=${a}`, "/link", `/unlink?from=${a}`, "/unlink"]) {
    const r = await call("POST", route);
    assert.equal(r.status, 400, route);
    assert.equal(r.body.error, "name both cards: from=ID&to=ID", route);
  }
  assert.equal((await call("POST", `/unlink?from=m99999&to=${a}`)).status, 400);
  const read = await call("GET", "/links?box=m99999");
  assert.equal(read.status, 400);
  assert.equal(read.body.error, "no card m99999 on the board");
  assert.equal((await call("GET", "/links")).status, 400);
  assert.equal((await saved()).rev, rev, "nothing refused was saved");
  assert.ok(!("links" in (await card(a))));
});

test("/unlink takes a link away, and one not there is answered as already gone", async () => {
  const a = await make("Unlink from");
  const b = await make("Unlink to");
  const c = await make("Stays linked");
  await post(`/link?from=${a}&to=${b}&agent=claude`);
  await post(`/link?from=${a}&to=${c}&agent=claude`);
  const gone = await post(`/unlink?from=${a}&to=${b}&agent=claude`);
  assert.deepEqual(gone, { ok: true, removed: true });
  assert.deepEqual(ids((await links(a)).links), [c]);
  assert.deepEqual((await links(b)).backlinks, []);
  const row = (await linkRows()).find(r => r.kind === "unlink" && r.box === a);
  assert.equal(row.to, b);
  assert.equal(row.agent, "claude");
  const rev = (await saved()).rev;
  assert.deepEqual(await post(`/unlink?from=${a}&to=${b}`), { ok: true, removed: false });
  assert.deepEqual(await post(`/unlink?from=${b}&to=${a}`), { ok: true, removed: false }, "a link has a direction");
  assert.equal((await saved()).rev, rev);
  await post(`/unlink?from=${a}&to=${c}`);
  assert.ok(!("links" in (await card(a))), "a card with no links left carries no field");
});

test("renaming either card or moving it between sections changes nothing about its links", async () => {
  const a = await make("Before the rename");
  const b = await make("Other before the rename");
  await post(`/link?from=${a}&to=${b}&agent=claude`);
  const kept = (await card(a)).links;
  await post(`/title?box=${b}`, "Other after the rename");
  await post(`/title?box=${a}`, "After the rename");
  const moves = [[`/dock?box=${b}&v=1`, "docked"], [`/park?box=${b}&v=1`, "deferred"],
    [`/done?box=${b}&v=1`, "done"], [`/done?box=${b}&v=0`, "doing"]];
  for (const [route, section] of moves) {
    await post(route);
    const row = (await links(a)).links[0];
    assert.equal(row.id, b);
    assert.equal(row.title, "Other after the rename", "the title is read as it is now");
    assert.equal(row.section, section, route);
  }
  await post(`/dock?box=${a}&v=1`);
  const back = (await links(b)).backlinks[0];
  assert.equal(back.title, "After the rename");
  assert.equal(back.section, "docked");
  assert.deepEqual((await card(a)).links, kept, "the stored link is exactly as it was made");
  assert.ok(!("links" in (await card(b))));
});

test("a card deleted for good takes its links both ways with it", async () => {
  const a = await make("Links to the empty card");
  const b = await make("Linked from the empty card");
  const gone = await make("Empty card to delete");
  await post(`/link?from=${a}&to=${gone}&agent=claude`);
  await post(`/link?from=${a}&to=${b}&agent=claude`);
  await post(`/link?from=${gone}&to=${b}&agent=claude`);
  assert.equal((await post(`/delete?box=${gone}`)).action, "deleted");
  assert.deepEqual(ids((await links(a)).links), [b]);
  assert.deepEqual(ids((await links(b)).backlinks), [a]);
  assert.deepEqual((await card(a)).links.map(l => l.to), [b], "the link to it is gone from the saved card");
  assert.ok(!(await saved()).boxes.some(x => x.id === gone));
  const dropped = (await linkRows()).filter(r => r.kind === "unlink" && r.why === "deleted");
  assert.deepEqual(dropped.filter(r => r.box === a).map(r => r.to), [gone]);
  assert.deepEqual(dropped.filter(r => r.box === gone).map(r => r.to), [b]);
  assert.equal((await call("POST", `/link?from=${a}&to=${gone}`)).status, 400, "it cannot be linked again");
});

test("a card in the Bin keeps its links out of sight and back on a restore; after 30 days they go", async () => {
  const a = await make("Points at the binned card");
  const b = await make("Pointed at by the binned card");
  const binned = await make("Goes to the Bin");
  await post(`/link?from=${a}&to=${binned}&agent=claude`);
  await post(`/link?from=${binned}&to=${b}&agent=claude`);
  const kept = (await card(binned)).links;
  await post(`/bin?box=${binned}`);
  assert.deepEqual((await links(a)).links, [], "no reading shows a card in the Bin");
  assert.deepEqual((await links(b)).backlinks, []);
  assert.equal((await call("GET", `/links?box=${binned}`)).status, 400);
  assert.equal((await call("POST", `/link?from=${b}&to=${binned}`)).status, 400);
  await post(`/bin/restore?box=${binned}`);
  assert.deepEqual(ids((await links(a)).links), [binned], "back on a restore");
  assert.deepEqual(ids((await links(b)).backlinks), [binned]);
  assert.deepEqual((await card(binned)).links, kept);

  await post(`/bin?box=${binned}`);
  await board.restart(async () => {
    const state = await saved();
    state.bin.find(e => e.card.id === binned).ts = Date.now() / 1000 - 31 * 86400;
    await writeFile(statePath(), JSON.stringify(state));
  });
  const state = await saved();
  assert.ok(!state.bin.some(e => e.card.id === binned), "deleted for good");
  assert.ok(!("links" in state.boxes.find(x => x.id === a)), "the link to it went with it");
  assert.deepEqual((await links(b)).backlinks, []);
  const dropped = (await linkRows()).filter(r => r.kind === "unlink" && r.why === "deleted");
  assert.ok(dropped.some(r => r.box === a && r.to === binned));
  assert.ok(dropped.some(r => r.box === binned && r.to === b));
});

test("a link whose save fails is not kept and leaves no transcript row", async () => {
  const a = await make("Save fails from here");
  const b = await make("Save fails to here");
  const before = await rows();
  await chmod(board.data, 0o500);
  let r;
  try { r = await call("POST", `/link?from=${a}&to=${b}&agent=claude`); }
  finally { await chmod(board.data, 0o700); }
  assert.equal(r.status, 500);
  assert.deepEqual((await links(a)).links, []);
  assert.deepEqual((await links(b)).backlinks, []);
  assert.ok(!("links" in (await card(a))));
  assert.deepEqual(await rows(), before);
  assert.equal((await post(`/link?from=${a}&to=${b}&agent=claude`)).added, true, "the retry makes it afresh");
});

test("links survive a restart exactly as they were made", async () => {
  const a = await make("Linked before the restart");
  const b = await make("Also before the restart");
  const made = await post(`/link?from=${a}&to=${b}&agent=claude`);
  const before = await links(a);
  await board.restart();
  assert.deepEqual(await links(a), before);
  assert.deepEqual((await links(b)).backlinks, [{ id: a, title: "Linked before the restart",
    owner: "facilitator", section: "doing", ts: made.ts, agent: "claude" }]);
  assert.deepEqual((await card(a)).links, [{ to: b, ts: made.ts, agent: "claude" }]);
});

test("a board saved before links loads with every card as it was", async () => {
  let old;
  await board.restart(async () => {
    old = await saved();
    for (const x of [...old.boxes, ...old.bin.map(e => e.card)]) delete x.links;
    await writeFile(statePath(), JSON.stringify(old));
  });
  const now = await saved();
  assert.deepEqual(now.boxes, old.boxes, "no card gains or loses a field");
  assert.deepEqual(now.bin, old.bin);
  assert.ok(!now.boxes.some(x => "links" in x));
  for (const x of now.boxes) {
    const read = await links(x.id);
    assert.deepEqual([read.links, read.backlinks], [[], []], x.id);
  }
});
