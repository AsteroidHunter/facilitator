// Card properties, over real HTTP on a copied board on free ports: GET /props
// reads one card's id, lane, section, when it was made, when it last changed,
// its branch and its status, and an agent sets or clears the branch and the
// status with POST /props. Made and last changed are kept on the card and moved
// with every transcript row about it, so they read as the transcript says:
// made is the card's create row, last changed its newest row. A card saved
// before the board kept them is given both once from the transcript, and the
// transcript is not read for them again. The branch and the status are kept on
// the card with when each was set and by which agent; each is written to the
// transcript, survives a restart, stays through a rename or a move between
// sections, waits in the Bin with its card and goes when the card is deleted
// for good. A board saved before properties loads exactly as it was.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { chmod, readFile, writeFile } = require("node:fs/promises");
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
const card = async id => (await saved()).boxes.find(b => b.id === id);
const rows = async () => (await readFile(transcriptPath(), "utf8"))
  .split("\n").filter(Boolean).map(line => JSON.parse(line));
const propRows = async kind => (await rows()).filter(r => r.kind === kind);
// the transcript's own word on one card: its create row and its newest row
const createdAt = async id => (await rows()).filter(r => r.kind === "create" && r.box === id).at(-1).ts;
const newest = async id => Math.max(...(await rows()).filter(r => r.box === id).map(r => r.ts));
const make = async title => (await post("/create?owner=facilitator", title)).id;
const props = id => get(`/props?box=${id}`);
// nothing of these is ever stored on a card: only made and changed are kept
const COPIES = ["made_ts", "changed_ts", "created", "updated", "number"];
// the card's own two times, as state.json keeps them
const kept = async id => { const x = await card(id); return [x.made, x.changed]; };

// what /props read from the transcript before the cards kept their times, and
// what the one fill from it gives: made is the card's create row, or for a card
// without one the earliest of its lane's project row, its own first row and its
// ts; last changed is its newest row, or its ts if later. a deletion under the
// same id starts it over, since the rows before are another card's
function logged(lines, x) {
  let created = null, first = null, newest = null, project = null;
  for (const r of lines) {
    if (typeof r.ts !== "number") continue;
    if (r.box === x.owner && r.kind === "project") project = r.ts;
    if (r.box !== x.id) continue;
    if (r.kind === "delete" || r.kind === "expire") { created = first = newest = null; continue; }
    if (r.kind === "create") created = r.ts;
    if (first === null) first = r.ts;
    newest = newest === null ? r.ts : Math.max(newest, r.ts);
  }
  const known = list => list.filter(t => typeof t === "number");
  return [created ?? Math.min(...known([project, first, x.ts])), Math.max(...known([newest, x.ts]))];
}

test("/props reads a card's id, lane, section and times from what the board keeps; a new card keeps when it was made", async () => {
  const a = await make("Props of a new card");
  const read = await props(a);
  assert.deepEqual(Object.keys(read), ["id", "title", "owner", "section", "made", "changed", "branch", "status"]);
  assert.equal(read.id, a);
  assert.equal(read.title, "Props of a new card");
  assert.equal(read.owner, "facilitator");
  assert.equal(read.section, "doing");
  assert.equal(read.made, await createdAt(a), "made is its create row's time");
  assert.equal(read.changed, await newest(a), "last changed is its newest row's time, here the create row");
  assert.equal(read.branch, null, "no branch until an agent sets one");
  assert.equal(read.status, null, "nor a status");
  assert.deepEqual(await kept(a), [read.made, read.changed], "both are kept on the card as it is made");
  const stored = await card(a);
  for (const field of [...COPIES, "branch", "status"]) assert.ok(!(field in stored), `the card stores no ${field}`);

  // a seed card has no rows at all: both times are its own ts
  const lane = await props("1.1");
  assert.equal(lane.id, "1.1");
  assert.equal(lane.owner, "pastureland");
  const seeded = await card("1.1");
  assert.deepEqual([lane.made, lane.changed], [seeded.ts, seeded.ts]);
  assert.deepEqual(await kept("1.1"), [seeded.ts, seeded.ts]);

  // the board's readings are what they were: nothing on screen changes
  for (const route of ["/state", "/m/state"]) {
    const shown = (await get(route)).boxes.find(x => x.id === a);
    for (const field of ["made", "changed", ...COPIES, "branch", "status"])
      assert.ok(!(field in shown), `${route} carries no ${field}`);
  }
});

test("every event on a card moves its last changed time to that event's row, and reading it moves nothing", async () => {
  const a = await make("Changes as it goes");
  const b = await make("Linked from the changing card");
  const made = (await props(a)).made;
  let last = (await props(a)).changed;
  const steps = [[`/title?box=${a}`, "Renamed as it goes"], [`/send?box=${a}`, "a message on it"],
    [`/reply?box=${a}`, "an answer on it"],
    [`/dock?box=${a}&v=1`], [`/park?box=${a}&v=1`], [`/done?box=${a}&v=1`], [`/done?box=${a}&v=0`],
    [`/link?from=${a}&to=${b}&agent=claude`], [`/props?box=${a}&branch=v0/changes&agent=claude`],
    [`/props?box=${a}&status=waiting+on+review&agent=claude`], [`/unlink?from=${a}&to=${b}&agent=claude`]];
  for (const [route, body] of steps) {
    await post(route, body);
    const read = await props(a);
    assert.ok(read.changed > last, `${route} moves it`);
    assert.equal(read.changed, await newest(a), `${route}: the newest row's time`);
    assert.equal(read.made, made, `${route} leaves when it was made`);
    assert.deepEqual(await kept(a), [made, read.changed], `${route}: as the card keeps them`);
    last = read.changed;
  }
  for (const field of COPIES) assert.ok(!(field in (await card(a))), `the card still stores no ${field}`);

  // a link from another card is that card's change, not this one's
  const other = (await props(b)).changed;
  await post(`/link?from=${b}&to=${a}&agent=claude`);
  assert.equal((await props(a)).changed, last, "being linked to changes nothing on the card");
  assert.ok((await props(b)).changed > other);

  const rev = (await saved()).rev;
  for (const route of [`/props?box=${a}`, `/links?box=${a}`, `/thread?box=${a}`, "/state", "/m/state"]) await get(route);
  assert.equal((await props(a)).changed, last, "reading a card changes nothing");
  assert.equal((await saved()).rev, rev, "nothing is saved by a reading");
});

for (const [name, first, second, word] of [["branch", "v0/card-properties", "v0/props-two", "the branch"],
  ["status", "building", "waiting on review", "the status"]]) {
  test(`an agent sets a card's ${name}; setting it again, changing it and clearing it each do what they say`, async () => {
    const a = await make(`Work with a ${name}`);
    const before = await props(a);
    const was = Date.now() / 1000;
    const set = await post(`/props?box=${a}&${name}=${encodeURIComponent(first)}&agent=claude`);
    assert.deepEqual(Object.keys(set), ["ok", "saved", "id", "branch", "status"]);
    assert.equal(set.ok, true);
    assert.equal(set.saved, true);
    assert.equal(set.id, a);
    assert.equal(set[name].value, first);
    assert.equal(set[name].agent, "claude");
    assert.ok(set[name].ts >= was - 1 && set[name].ts <= Date.now() / 1000 + 1, "it carries the time it was set");
    const read = await props(a);
    assert.deepEqual(read[name], set[name], "/props reads it as set");
    assert.equal(read.made, before.made);
    assert.ok(read.changed > before.changed, `setting ${word} is a change`);
    assert.deepEqual((await card(a))[name], set[name], "kept on the card");
    const row = (await propRows(name)).find(r => r.box === a);
    assert.equal(row[name], first);
    assert.equal(row.agent, "claude");
    assert.equal(row.ts, read.changed);
    assert.deepEqual((await get(`/thread?box=${a}`)).messages, [], "the card's thread is untouched");

    const rev = (await saved()).rev;
    const again = await post(`/props?box=${a}&${name}=${encodeURIComponent(first)}&agent=codex`);
    assert.equal(again.saved, false, `${word} it already has`);
    assert.deepEqual(again[name], set[name], "the first setting stands, with its time and agent");
    assert.equal((await saved()).rev, rev, "nothing is saved again");
    assert.equal((await propRows(name)).filter(r => r.box === a).length, 1, "one transcript row");

    const moved = await post(`/props?box=${a}&${name}=%20${encodeURIComponent(second)}%20&agent=codex`);
    assert.equal(moved.saved, true);
    assert.equal(moved[name].value, second, "the value is trimmed");
    assert.equal(moved[name].agent, "codex", "another value replaces the first, with its own agent");

    const cleared = await post(`/props?box=${a}&${name}=&agent=codex`);
    assert.equal(cleared.saved, true);
    assert.equal(cleared[name], null);
    assert.ok(!(name in (await card(a))), `a cleared ${name} leaves no field`);
    const clearRow = (await propRows(name)).filter(r => r.box === a).at(-1);
    assert.equal(clearRow[name], "", "the clearing row names nothing");
    assert.equal(clearRow.agent, "codex");
    const rev2 = (await saved()).rev;
    assert.equal((await post(`/props?box=${a}&${name}=`)).saved, false, `clearing ${word} when there is none`);
    assert.equal((await saved()).rev, rev2);
    assert.equal((await post(`/props?box=${a}&${name}=x`))[name].agent, "", "no agent named is an empty name");
  });
}

test("the branch and the status are set together in one save, each with its own row, and each leaves the other alone", async () => {
  const a = await make("Both at once");
  const rev = (await saved()).rev;
  const both = await post(`/props?box=${a}&branch=v0/both&status=building&agent=claude`);
  assert.equal(both.saved, true);
  assert.equal(both.branch.value, "v0/both");
  assert.equal(both.status.value, "building");
  assert.equal((await saved()).rev, rev + 1, "one save");
  assert.equal((await propRows("branch")).filter(r => r.box === a).length, 1);
  assert.equal((await propRows("status")).filter(r => r.box === a).length, 1);
  const status = await post(`/props?box=${a}&status=merged&agent=claude`);
  assert.deepEqual(status.branch, both.branch, "setting the status leaves the branch");
  const branch = await post(`/props?box=${a}&branch=&agent=claude`);
  assert.equal(branch.branch, null);
  assert.deepEqual(branch.status, status.status, "clearing the branch leaves the status");
  const same = await post(`/props?box=${a}&branch=&status=merged`);
  assert.equal(same.saved, false, "both already as asked");
});

test("an unknown card, no card, no property, a long value or one with a line break is refused", async () => {
  const a = await make("Refusals for props");
  const rev = (await saved()).rev;
  const none = "name a property: branch=NAME or status=TEXT, empty to clear it";
  const refusals = [
    ["GET", "/props?box=m99999", "no card m99999 on the board"],
    ["GET", "/props", "name the card: box=ID"],
    ["POST", "/props?box=m99999&branch=main", "no card m99999 on the board"],
    ["POST", "/props?box=m99999&status=done", "no card m99999 on the board"],
    ["POST", "/props?branch=main", "name the card: box=ID"],
    ["POST", `/props?box=${a}`, none],
    ["POST", `/props?box=${a}&agent=claude`, none],
    ["POST", `/props?box=${a}&branch=${"b".repeat(201)}`, "a branch is at most 200 characters"],
    ["POST", `/props?box=${a}&status=${"s".repeat(201)}`, "a status is at most 200 characters"],
    ["POST", `/props?box=${a}&branch=one%0Atwo`, "a branch is one line of plain text"],
    ["POST", `/props?box=${a}&status=one%09two`, "a status is one line of plain text"],
    ["POST", `/props?box=${a}&branch=fine&status=one%0Atwo`, "a status is one line of plain text"],
  ];
  for (const [method, route, error] of refusals) {
    const r = await call(method, route);
    assert.equal(r.status, 400, route);
    assert.equal(r.body.error, error, route);
  }
  assert.equal((await saved()).rev, rev, "nothing refused was saved");
  const kept = await card(a);
  assert.ok(!("branch" in kept) && !("status" in kept), "a refused pair sets neither half");
  assert.equal((await post(`/props?box=${a}&branch=${"b".repeat(200)}`)).saved, true, "200 characters is allowed");
});

test("renaming a card or moving it between sections keeps its id, its made time, its branch and its status", async () => {
  const a = await make("Before the props rename");
  const set = await post(`/props?box=${a}&branch=v0/rename&status=building&agent=claude`);
  const made = (await props(a)).made;
  await post(`/title?box=${a}`, "After the props rename");
  const moves = [[`/dock?box=${a}&v=1`, "docked"], [`/park?box=${a}&v=1`, "deferred"],
    [`/done?box=${a}&v=1`, "done"], [`/done?box=${a}&v=0`, "doing"]];
  for (const [route, section] of moves) {
    await post(route);
    const read = await props(a);
    assert.equal(read.id, a, route);
    assert.equal(read.title, "After the props rename", "the title is read as it is now");
    assert.equal(read.section, section, route);
    assert.equal(read.made, made, route);
    assert.deepEqual([read.branch, read.status], [set.branch, set.status], route);
  }
});

test("a card in the Bin keeps its properties out of sight and back on a restore; after 30 days they go", async () => {
  const binned = await make("Props card for the Bin");
  const set = await post(`/props?box=${binned}&branch=v0/binned&status=parked+for+later&agent=claude`);
  const made = (await props(binned)).made;
  await post(`/bin?box=${binned}`);
  assert.equal((await call("GET", `/props?box=${binned}`)).status, 400, "no reading shows a card in the Bin");
  assert.equal((await call("POST", `/props?box=${binned}&branch=other`)).status, 400, "and none sets one");
  const inBin = (await saved()).bin.find(e => e.card.id === binned).card;
  assert.deepEqual([inBin.branch, inBin.status], [set.branch, set.status], "they wait with the card");
  assert.deepEqual([inBin.made, inBin.changed], [made, await newest(binned)],
    "its times wait with it too, going in the Bin its newest change");
  await board.restart();
  const still = (await saved()).bin.find(e => e.card.id === binned).card;
  assert.deepEqual([still.made, still.changed], [inBin.made, inBin.changed], "a restart leaves them as they were");
  await post(`/bin/restore?box=${binned}`);
  const back = await props(binned);
  assert.deepEqual([back.branch, back.status], [set.branch, set.status], "back on a restore");
  assert.equal(back.made, made);
  assert.equal(back.changed, await newest(binned), "the restore is its newest change");
  assert.deepEqual(await kept(binned), [back.made, back.changed]);

  await post(`/bin?box=${binned}`);
  await board.restart(async () => {
    const state = await saved();
    state.bin.find(e => e.card.id === binned).ts = Date.now() / 1000 - 31 * 86400;
    await writeFile(statePath(), JSON.stringify(state));
  });
  const state = await saved();
  assert.ok(!state.bin.some(e => e.card.id === binned) && !state.boxes.some(x => x.id === binned),
    "deleted for good, properties and all");
  assert.equal((await call("GET", `/props?box=${binned}`)).status, 400);
  const next = await make("Made after the deletion");
  assert.notEqual(next, binned, "its id is never handed out again");
  assert.deepEqual([(await props(next)).branch, (await props(next)).status], [null, null]);
});

test("a card deleted for good at once takes its properties along", async () => {
  const gone = await make("Empty props card to delete");
  await post(`/props?box=${gone}&branch=v0/gone&status=dropped&agent=claude`);
  assert.equal((await post(`/delete?box=${gone}`)).action, "deleted");
  assert.ok(!(await saved()).boxes.some(x => x.id === gone));
  const r = await call("GET", `/props?box=${gone}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, `no card ${gone} on the board`);
});

test("a property whose save fails is not kept, moves no time and leaves no transcript row", async () => {
  const a = await make("Props save fails");
  const before = await props(a);
  const was = await rows();
  await chmod(board.data, 0o500);
  let r;
  try { r = await call("POST", `/props?box=${a}&branch=v0/fails&status=building&agent=claude`); }
  finally { await chmod(board.data, 0o700); }
  assert.equal(r.status, 500);
  assert.deepEqual(await props(a), before, "neither property nor the last changed time stayed");
  const kept = await card(a);
  assert.ok(!("branch" in kept) && !("status" in kept));
  assert.deepEqual(await rows(), was);
  assert.equal((await post(`/props?box=${a}&branch=v0/fails&agent=claude`)).saved, true, "the retry sets it afresh");
});

test("properties survive a restart exactly as they were", async () => {
  const a = await make("Props before the restart");
  await post(`/props?box=${a}&branch=v0/restart&status=building&agent=claude`);
  const before = await props(a);
  const stored = (await card(a));
  await board.restart();
  assert.deepEqual(await props(a), before);
  const after = await card(a);
  assert.deepEqual([after.branch, after.status], [stored.branch, stored.status]);
});

test("a board saved before the cards kept their times is given them once from its transcript, as /props read them", async () => {
  // a new project's first card is made with the project's row, not a create row
  const project = await post("/project?name=props-lane", homedir());
  const omni = (await saved()).boxes.find(x => x.owner === project.id).id;
  const projectRow = (await rows()).find(r => r.kind === "project" && r.box === project.id).ts;
  const created = (await card(omni)).ts;
  assert.deepEqual(await kept(omni), [created, created], "it keeps the time it was made, just before its project's row");
  assert.ok(created <= projectRow);
  // written to since, so its own ts has moved on past the moment it was made
  await post(`/send?box=${omni}`, "a message on the project's first card");
  const binned = await make("In the Bin across the upgrade");
  await post(`/send?box=${binned}`, "a message before the Bin");
  await post(`/bin?box=${binned}`);
  // a card made since the last start is given its reply fields on the next one,
  // so the board goes through one start first, as any board saved before
  // properties has; how far one start moves the revision is measured on it
  const rev0 = (await saved()).rev;
  await board.restart();
  const startSaves = (await saved()).rev - rev0;
  const lane = "1.1";
  const early = 1700000000.5;   // older than anything the lane card keeps
  let old, transcript;
  await board.restart(async () => {
    old = await saved();
    // as a board saved before properties and before the cards kept their times
    for (const x of [...old.boxes, ...old.bin.map(e => e.card)]) {
      delete x.branch; delete x.status; delete x.made; delete x.changed;
    }
    await writeFile(statePath(), JSON.stringify(old));
    // rows older than the board's own: the lane card was written to before it
    // has any time of its own, and an older board made and deleted another
    // card under the seed card's id, which says nothing about the seed card
    transcript = [
      { ts: early - 100, kind: "create", box: "0", text: "an older card" },
      { ts: early - 50, kind: "delete", box: "0", text: "an older card" },
      { ts: early, kind: "user", box: lane, text: "an older message" },
    ].map(r => JSON.stringify(r) + "\n").join("") + await readFile(transcriptPath(), "utf8");
    await writeFile(transcriptPath(), transcript);
  });
  const now = await saved();
  const lines = await rows();
  // every card, in the Bin as well, gains its two times, as the transcript
  // gives them, and nothing else
  const filled = x => { const [made, changed] = logged(lines, x); return { ...x, made, changed }; };
  assert.deepEqual(now.boxes, old.boxes.map(filled), "each card gains made and changed and nothing else");
  assert.deepEqual(now.bin, old.bin.map(e => ({ ...e, card: filled(e.card) })), "and so does a card in the Bin");
  const inBin = now.bin.find(e => e.card.id === binned).card;
  assert.equal(inBin.made, lines.find(r => r.kind === "create" && r.box === binned).ts);
  assert.equal(inBin.changed, lines.filter(r => r.kind === "bin" && r.box === binned).at(-1).ts,
    "the card in the Bin last changed when it went in");
  for (const key of Object.keys(old).filter(k => !["rev", "boxes", "bin"].includes(k)))
    assert.deepEqual(now[key], old[key], `${key} is as it was`);
  assert.deepEqual(Object.keys(now).sort(), Object.keys(old).sort());
  assert.equal(now.rev, old.rev + startSaves, "only the saves every start makes");
  assert.equal(await readFile(transcriptPath(), "utf8"), transcript, "reading the times wrote nothing");

  for (const x of now.boxes) {
    const read = await props(x.id);
    assert.deepEqual([read.made, read.changed], [x.made, x.changed], `${x.id}: /props reads what the card keeps`);
    assert.ok(typeof read.made === "number" && read.changed >= read.made, x.id);
    // its create row, unless a deletion under the same id came after it
    const own = lines.filter(r => r.box === x.id && ["create", "delete", "expire"].includes(r.kind)).at(-1);
    if (own && own.kind === "create") assert.equal(read.made, own.ts, `${x.id} was made when its create row says`);
    assert.deepEqual([read.branch, read.status], [null, null], x.id);
  }
  assert.ok(!lines.some(r => r.kind === "create" && r.box === omni), "the project's first card has no create row");
  assert.equal((await props(omni)).made, projectRow,
    "a project's first card was made with the project's row, not at its first message");
  const seed = now.boxes.find(x => x.id === "0");
  assert.equal((await props("0")).made, seed.ts,
    "a card with no rows of its own was made at its own time, not at another card's under its id");
  const laneRead = await props(lane);
  assert.equal(laneRead.made, early, "a card with no create row was made at its first row");
  assert.equal(laneRead.changed, now.boxes.find(x => x.id === lane).ts, "and last changed at its newest time");

  // a second start fills nothing: every card already has its times
  await board.restart();
  const again = await saved();
  assert.deepEqual(again.boxes, now.boxes, "a second start changes no card");
  assert.deepEqual(again.bin, now.bin, "nor one in the Bin");
  assert.equal(again.rev, now.rev + startSaves, "only the saves every start makes");
  assert.equal(await readFile(transcriptPath(), "utf8"), transcript, "and writes nothing to the transcript");

  // from here the transcript is not read for them: a start with it gone and a
  // card's times changed by hand reads them from the card
  const readings = {};
  for (const x of again.boxes) readings[x.id] = await props(x.id);
  const handSet = [1600000000.25, 1600000500.75];
  await board.restart(async () => {
    const state = await saved();
    Object.assign(state.boxes.find(x => x.id === lane), { made: handSet[0], changed: handSet[1] });
    await writeFile(statePath(), JSON.stringify(state));
    await writeFile(transcriptPath(), "");
  });
  for (const x of again.boxes.filter(x => x.id !== lane))
    assert.deepEqual(await props(x.id), readings[x.id], `${x.id} reads as before with no transcript`);
  const byHand = await props(lane);
  assert.deepEqual([byHand.made, byHand.changed], handSet, "the times are the card's, not the transcript's");
  assert.deepEqual((await saved()).bin, again.bin, "the card in the Bin keeps its times with no transcript");
});
