// the typing hold: a card the reader is typing on is not handed to an agent
// until seven seconds after the last change its page reported (POST /typing),
// while the lane's other cards go out as ever; a listener already waiting gets
// the card the moment its hold runs out, not at the end of its wait; reports
// that keep coming keep the card held; the reader's message on the card clears
// the hold at once; and a report writes nothing, neither state.json nor the
// transcript, and leaves the card's changed time where it was. read through a
// real fixture server on a free port; the suite never touches port 8877. every
// card and message below is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const HOLD_MS = 7000;   // TYPING_HOLD in server.py
const LATE_MS = 500;    // how late the waiting listener may be told, at most
const SEED = { title: "typing hold board", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
  { id: "7", bucket: "now", title: "Card A, being typed on", owner: "facilitator" },
  { id: "8", bucket: "now", title: "Card B, left alone", owner: "facilitator" },
] };

let board;
before(async () => { board = await startBoard({ seed: SEED }); });
after(async () => { if (board) await board.stop(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function post(route, body = "") {
  const response = await fetch(board.origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function get(route) {
  const response = await fetch(board.origin + route);
  return { status: response.status, body: await response.json() };
}

// the agent's own two calls, and its answer, so the lane is free again
async function claim(timeout) {
  const started = Date.now();
  const said = await get(`/wait?owner=facilitator&timeout=${timeout}&agent=claude`);
  assert.equal(said.status, 200);
  return { ...said.body, at: Date.now(), took: Date.now() - started };
}
async function answer(handed) {
  assert.equal((await post(`/ack?owner=facilitator&token=${handed.ack}`)).status, 200);
  assert.equal((await post(`/reply?box=${handed.box}`, "an invented answer")).status, 200);
}

async function typing(box) {
  const said = await post(`/typing?box=${box}`);
  assert.deepEqual(said, { status: 200, body: { ok: true } });
  return Date.now();
}

async function files() {
  return {
    state: await readFile(path.join(board.data, "state.json"), "utf8"),
    transcript: await readFile(path.join(board.data, "transcript.jsonl"), "utf8"),
    props: (await get("/props?box=7")).body,
    rev: (await get("/state")).body.rev,
  };
}

test("a report names a card the board has", async () => {
  assert.equal((await post("/typing?box=nosuchcard")).status, 400);
  assert.equal((await post("/typing")).status, 400);
});

test("the card being typed on waits, the next one goes, and the waiting listener gets it when the hold runs out", async () => {
  assert.equal((await post("/send?box=7", "first message on A")).status, 200);
  assert.equal((await post("/send?box=8", "first message on B")).status, 200);

  const kept = await files();
  let last = 0;
  for (let i = 0; i < 3; i++) last = await typing("7");
  // nothing written and nothing moved: the time lives in the server's memory only
  assert.deepEqual(await files(), kept);

  // A is first in the queue, and B is handed out instead of it, at once
  const first = await claim(30);
  assert.equal(first.box, "8");
  assert.ok(first.took < 1000, `B took ${first.took} ms`);
  await answer(first);

  // a listener asked now, with a long wait, is told about A once its hold ends
  const second = await claim(30);
  assert.equal(second.box, "7");
  assert.deepEqual(second.messages, ["first message on A"]);
  const since = second.at - last;
  assert.ok(since >= HOLD_MS - 50, `A came ${since} ms after the last report`);
  assert.ok(since <= HOLD_MS + LATE_MS, `A came ${since} ms after the last report`);
  await answer(second);
});

test("reports that keep coming keep the card held for as long as they come", async () => {
  assert.equal((await post("/send?box=7", "second message on A")).status, 200);
  let last = await typing("7");
  const waiting = claim(60);
  let handed = null;
  waiting.then(said => { handed = said; });
  // one report every two seconds for ten seconds: longer than the hold itself
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    assert.equal(handed, null, "the card went out while it was still being typed on");
    last = await typing("7");
  }
  const said = await waiting;
  assert.equal(said.box, "7");
  const since = said.at - last;
  assert.ok(since >= HOLD_MS - 50 && since <= HOLD_MS + LATE_MS, `A came ${since} ms after the last report`);
  await answer(said);
});

test("the reader's message on the card clears its hold at once", async () => {
  assert.equal((await post("/send?box=7", "third message on A")).status, 200);
  await typing("7");
  const waiting = claim(60);
  let handed = null;
  waiting.then(said => { handed = said; });
  await sleep(1000);
  assert.equal(handed, null, "the card went out while it was still being typed on");
  const sent = Date.now();
  assert.equal((await post("/send?box=7", "fourth message on A")).status, 200);
  const said = await waiting;
  assert.equal(said.box, "7");
  assert.deepEqual(said.messages, ["third message on A", "fourth message on A"]);
  assert.ok(said.at - sent < LATE_MS, `A came ${said.at - sent} ms after the send`);
  await answer(said);
});
