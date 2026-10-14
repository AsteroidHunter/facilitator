// The Bin, over real HTTP on a copied board on free ports: a card the garbage
// can deletes leaves every reading and every agent route, keeps its thread,
// queued messages and magic box, comes back whole and in place on a restore,
// and is deleted for good after 30 days, checked when the board starts.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile, readdir, writeFile } = require("node:fs/promises");
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
const desk = async () => (await call("GET", "/state")).body;
const deskIds = async () => (await desk()).boxes.map(b => b.id);
const phoneIds = async () => (await call("GET", "/m/state")).body.boxes.map(b => b.id);
const binList = async () => (await call("GET", "/bin")).body;
const saved = async () => JSON.parse(await readFile(path.join(board.app, "state.json"), "utf8"));
const magicFiles = async () => (await readdir(path.join(board.app, "magic-boxes")).catch(() => [])).filter(n => !n.startsWith("."));
const make = async title => (await post("/create?owner=facilitator", title)).id;
const wait = async () => (await call("GET", "/wait?owner=facilitator&timeout=1&agent=claude")).body;

// an agent's whole turn on one card: claim, confirm, read what is fresh, answer
async function answer(id, words) {
  const claim = await wait();
  assert.equal(claim.box, id, JSON.stringify(claim));
  await post(`/ack?owner=facilitator&token=${claim.ack}`);
  await call("GET", "/fresh?owner=facilitator");
  await post(`/reply?box=${id}`, words);
}

test("a deleted card leaves the board, the phone and the agents, and keeps everything", async () => {
  const keep = await make("Card that stays");
  const id = await make("Card to delete");
  await post(`/send?box=${id}`, "first question");
  await answer(id, "first answer");
  await post(`/magic?box=${id}&kind=text`, "what the box shows");
  await post(`/send?box=${id}`, "a second message, still queued");
  await post(`/dock?box=${id}&v=1`);
  const before = (await saved()).boxes.find(b => b.id === id);
  const order = await deskIds();
  const files = await magicFiles();
  assert.ok(files.some(n => n.startsWith(id + "-")), "the card has a magic box file");

  const done = await post(`/bin?box=${id}`);
  assert.equal(done.ok, true);
  assert.ok(!(await deskIds()).includes(id), "/state no longer shows it");
  assert.ok(!(await phoneIds()).includes(id), "/m/state no longer shows it");
  assert.ok((await deskIds()).includes(keep), "the other card stays");
  assert.deepEqual((await call("GET", "/unread?owner=facilitator")).body.queued, 0, "its queued message is off the queue");
  assert.equal((await wait()).idle, true, "no agent is handed it");
  assert.equal((await call("POST", `/send?box=${id}`, "to a binned card")).status, 400);
  assert.equal((await call("POST", `/magic?box=${id}&kind=text`, "x")).status, 400);

  const bin = await binList();
  assert.equal(bin.keepDays, 30);
  const row = bin.cards.find(c => c.id === id);
  assert.equal(row.title, "Card to delete");
  assert.equal(row.owner, "facilitator");
  assert.equal(row.section, "docked");
  assert.ok(Math.abs(row.until - row.ts - 30 * 86400) < 1);
  const state = await saved();
  assert.ok(!state.boxes.some(b => b.id === id));
  assert.ok(!state.inbox.includes(id));
  assert.deepEqual(state.bin.find(e => e.card.id === id).card, before, "the whole record is kept as it was");
  assert.deepEqual(await magicFiles(), files, "its magic box file is kept");

  const restored = await post(`/bin/restore?box=${id}`);
  assert.equal(restored.ok, true);
  assert.deepEqual(await deskIds(), order, "it is back in its own place");
  const back = (await desk()).boxes.find(b => b.id === id);
  assert.equal(back.docked, true, "and in its own section");
  assert.equal(back.title, "Card to delete");
  assert.ok((await phoneIds()).includes(id));
  assert.deepEqual((await saved()).boxes.find(b => b.id === id), before, "the record comes back whole");
  assert.equal((await binList()).cards.length, 0);
  const body = await call("GET", `/magic/body?box=${id}`);
  assert.equal(body.status, 200);
  assert.equal(body.body.text, "what the box shows");
  const thread = await call("GET", `/thread?box=${id}`);
  assert.equal(thread.status, 200);
  assert.match(JSON.stringify(thread.body), /first answer/, "the thread is still there");
  // its queued message is waiting again, and an agent is handed it
  const claim = await wait();
  assert.equal(claim.box, id);
  assert.deepEqual(claim.messages, ["a second message, still queued"]);
  await post(`/ack?owner=facilitator&token=${claim.ack}`);
  await post(`/reply?box=${id}`, "second answer");
});

test("a card deleted while an agent holds it frees the lane and loses no message", async () => {
  const id = await make("Claimed then deleted");
  const other = await make("Next in line");
  await post(`/send?box=${id}`, "held message");
  await post(`/send?box=${other}`, "other message");
  const claim = await wait();
  assert.equal(claim.box, id);
  await post(`/ack?owner=facilitator&token=${claim.ack}`);
  await post(`/bin?box=${id}`);
  const fresh = (await call("GET", "/fresh?owner=facilitator")).body;
  assert.ok(!JSON.stringify(fresh).includes("held message"), "nothing of it is handed on");
  assert.equal((await call("POST", `/reply?box=${id}`, "late answer")).status, 400, "no answer lands on it");
  const next = await wait();
  assert.equal(next.box, other, "the lane is free for the next card");
  await post(`/ack?owner=facilitator&token=${next.ack}`);
  await post(`/reply?box=${other}`, "answered");
  await post(`/bin/restore?box=${id}`);
  const again = await wait();
  assert.equal(again.box, id);
  assert.deepEqual(again.messages, ["held message"]);
  await post(`/ack?owner=facilitator&token=${again.ack}`);
  await post(`/reply?box=${id}`, "answered after all");
});

test("bad ids are refused and the phone's bridge cannot reach the Bin", async () => {
  assert.equal((await call("POST", "/bin?box=nope")).status, 400);
  assert.equal((await call("POST", "/bin/restore?box=nope")).status, 400);
  for (const [route, method] of [["/bin", "GET"], ["/bin", "POST"], ["/bin/restore", "POST"]]) {
    const r = await fetch(`http://127.0.0.1:${board.port + 1}${route}?box=0`, { method });
    assert.equal(r.status, 404, `${method} ${route} through the phone's port`);
  }
});

test("after 30 days in the Bin a card is deleted for good when the board starts; younger ones stay", async () => {
  const old = await make("Thirty one days");
  const young = await make("Twenty nine days");
  await post(`/magic?box=${old}&kind=text`, "old box");
  await post(`/magic?box=${young}&kind=text`, "young box");
  await post(`/bin?box=${old}`);
  await post(`/bin?box=${young}`);
  const live = (await saved()).boxes;
  const day = 86400;
  await board.restart(async () => {
    const state = await saved();
    const now = Date.now() / 1000;
    state.bin.find(e => e.card.id === old).ts = now - 31 * day;
    state.bin.find(e => e.card.id === young).ts = now - 29 * day;
    await writeFile(path.join(board.app, "state.json"), JSON.stringify(state));
  });
  const ids = (await binList()).cards.map(c => c.id);
  assert.ok(!ids.includes(old), "the 31 day card is gone");
  assert.ok(ids.includes(young), "the 29 day card stays");
  const state = await saved();
  assert.ok(!state.bin.some(e => e.card.id === old) && !state.boxes.some(b => b.id === old));
  assert.deepEqual(state.boxes.map(b => b.id), live.map(b => b.id), "nothing on the board is touched");
  const files = await magicFiles();
  assert.ok(!files.some(n => n.startsWith(old + "-")), "its magic box goes with it");
  assert.ok(files.some(n => n.startsWith(young + "-")), "the younger card's box stays");
  assert.equal((await call("POST", `/bin/restore?box=${old}`)).status, 400);
  await post(`/bin/restore?box=${young}`);
  assert.ok((await deskIds()).includes(young));
});

test("a board saved before the Bin starts with an empty one and every card as it was", async () => {
  const before = await saved();
  await board.restart(async () => {
    const state = await saved();
    delete state.bin;
    await writeFile(path.join(board.app, "state.json"), JSON.stringify(state));
  });
  const after = await saved();
  assert.deepEqual(after.bin, []);
  assert.deepEqual(after.boxes, before.boxes);
  assert.equal((await binList()).cards.length, 0);
});

test("a card in the Bin across a restart stays out of every reading and the queue", async () => {
  const id = await make("Binned across a restart");
  await post(`/send?box=${id}`, "waiting message");
  await post(`/bin?box=${id}`);
  await board.restart();
  assert.ok(!(await deskIds()).includes(id));
  assert.ok(!(await phoneIds()).includes(id));
  assert.ok(!(await saved()).inbox.includes(id), "the restart re-queue skips it");
  assert.equal((await wait()).idle, true);
  assert.ok((await binList()).cards.some(c => c.id === id));
  await post(`/bin/restore?box=${id}`);
  assert.equal((await wait()).box, id, "restored, its message is handed out");
});
