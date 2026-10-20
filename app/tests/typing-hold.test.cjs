// the typing hold: a card the reader is typing on is not handed to an agent
// until seven seconds after the last change on it, a change being a report from
// its page (POST /typing) or a message the reader sends on it, while the lane's
// other cards go out as ever; a listener already waiting gets the card the
// moment its hold runs out, not at the end of its wait; changes that keep coming
// keep the card held; an agent already holding the card is handed none of its
// new messages through /fresh until the same moment, and a reply before then
// leaves them queued for /wait; a report writes nothing, neither state.json
// nor the transcript, and leaves the card's changed time where it was; and a
// card the voice layer talks on (sent a message with via=voice) is never held,
// so its messages go out at once while a typed card beside it waits as ever.
// read through a real fixture server on a free port; the suite never touches
// port 8877. every card and message below is invented.
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
  // spoken to by the voice layer; its title is not what makes it a voice card
  { id: "9", bucket: "now", title: "Card C, spoken to", owner: "facilitator" },
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

// the agent's own calls, and its answer, so the lane is free again
async function claim(timeout) {
  const started = Date.now();
  const said = await get(`/wait?owner=facilitator&timeout=${timeout}&agent=claude`);
  assert.equal(said.status, 200);
  return { ...said.body, at: Date.now(), took: Date.now() - started };
}
async function ack(handed) {
  assert.equal((await post(`/ack?owner=facilitator&token=${handed.ack}`)).status, 200);
}
async function reply(box, text = "an invented answer") {
  assert.equal((await post(`/reply?box=${box}`, text)).status, 200);
}
async function answer(handed) {
  await ack(handed);
  await reply(handed.box);
}
// a listener opened now, whose answer is noted when it comes
function listen(timeout) {
  const waiting = { said: null };
  waiting.done = claim(timeout).then(said => { waiting.said = said; return said; });
  return waiting;
}

// the reader's two kinds of change, each answering when the board has it
async function typing(box) {
  const said = await post(`/typing?box=${box}`);
  assert.deepEqual(said, { status: 200, body: { ok: true } });
  return Date.now();
}
async function send(box, text) {
  assert.equal((await post(`/send?box=${box}`, text)).status, 200);
  return Date.now();
}
// a message spoken through the voice layer, sent the way app/voice/board.py
// sends it; answers when the send started, since the claim it wakes may come
// back before the send's own answer does
async function speak(box, text) {
  const started = Date.now();
  assert.equal((await post(`/send?box=${box}&via=voice&op=voice-${started}${box}`, text)).status, 200);
  return started;
}

async function card(id) {
  return (await get("/state")).body.boxes.find(b => b.id === id);
}
async function files() {
  return {
    state: await readFile(path.join(board.data, "state.json"), "utf8"),
    transcript: await readFile(path.join(board.data, "transcript.jsonl"), "utf8"),
    props: (await get("/props?box=7")).body,
    rev: (await get("/state")).body.rev,
  };
}

function onTime(t, since, what) {
  t.diagnostic(`${what} came ${since} ms after the last change`);
  assert.ok(since >= HOLD_MS - 50 && since <= HOLD_MS + LATE_MS, `${what} came ${since} ms after the last change`);
}

test("a report names a card the board has", async () => {
  assert.equal((await post("/typing?box=nosuchcard")).status, 400);
  assert.equal((await post("/typing")).status, 400);
});

test("a report writes nothing and moves nothing", async () => {
  const kept = await files();
  for (let i = 0; i < 3; i++) await typing("7");
  // the time lives in the server's memory only
  assert.deepEqual(await files(), kept);
});

test("a send with no typing after it goes out 7 seconds after the send", async t => {
  const waiting = listen(30);
  const sent = await send("7", "a message and nothing typed after it");
  await sleep(HOLD_MS - 1000);
  assert.equal(waiting.said, null, "the card went out at the send");
  const said = await waiting.done;
  assert.equal(said.box, "7");
  assert.deepEqual(said.messages, ["a message and nothing typed after it"]);
  onTime(t, said.at - sent, "A");
  await answer(said);
});

test("a reader sending a word at a time while typing gets the card handed out once, 7 seconds after the last change", async t => {
  // the listener is open before the first word, as an agent's always is
  const waiting = listen(60);
  await sleep(200);
  const words = ["Because", "you", "read", "my", "messages"];
  let last = 0;
  for (const [i, word] of words.entries()) {
    if (i) await sleep(2000);
    last = await send("7", word);
    assert.equal(waiting.said, null, `the card went out at word ${i + 1}`);
    await sleep(1000);
    assert.equal(waiting.said, null, `the card went out after word ${i + 1}`);
    last = await typing("7");
  }
  const said = await waiting.done;
  assert.equal(said.box, "7");
  assert.deepEqual(said.messages, words);
  onTime(t, said.at - last, "A");
  await answer(said);
});

test("changes that keep coming keep the card held, and the lane's other card goes out as ever", async t => {
  await send("7", "a message on A, typed on after");
  const sentB = await send("8", "a message on B, left alone");
  let last = await typing("7");
  let second = null;
  // one report on A every two seconds for twelve seconds: longer than the hold
  // itself, and going on while B is handed out and answered
  const typist = (async () => {
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      if (second) assert.equal(second.said, null, "A went out while it was still being typed on");
      last = await typing("7");
    }
  })();
  // A is first in the queue; B goes out at the end of its own hold while A is
  // still being typed on, and A keeps its place behind it
  const first = await claim(60);
  assert.equal(first.box, "8");
  assert.equal(first.queued_after, 1);
  onTime(t, first.at - sentB, "B");
  await answer(first);
  second = listen(60);
  await typist;
  assert.equal(second.said, null, "A went out while it was still being typed on");
  const said = await second.done;
  assert.equal(said.box, "7");
  assert.deepEqual(said.messages, ["a message on A, typed on after"]);
  onTime(t, said.at - last, "A");
  await answer(said);
});

test("an agent holding the card gets its new messages from /fresh only 7 seconds after the last change", async t => {
  await send("7", "the question the agent holds");
  const handed = await claim(30);
  assert.equal(handed.box, "7");
  await ack(handed);

  await typing("7");
  await send("7", "a first thought while the agent works");
  const last = await send("7", "and a second");
  // right after: the held card is named, and nothing new is handed over
  assert.deepEqual((await get("/fresh?owner=facilitator")).body,
    { box: "7", messages: [], message_via: [] });
  assert.deepEqual((await get("/unread?owner=facilitator")).body, { queued: 2, claimed: 1 });
  assert.deepEqual((await card("7")).pendingStates, ["delivered", "sent", "sent"]);

  // asked every tenth of a second, /fresh hands both over once the hold is out
  let fresh;
  for (;;) {
    fresh = (await get("/fresh?owner=facilitator")).body;
    if (fresh.messages.length || Date.now() - last > HOLD_MS + 2000) break;
    await sleep(100);
  }
  assert.deepEqual(fresh.messages, ["a first thought while the agent works", "and a second"]);
  onTime(t, Date.now() - last, "/fresh's messages");
  assert.deepEqual((await get("/unread?owner=facilitator")).body, { queued: 0, claimed: 3 });
  assert.deepEqual((await card("7")).pendingStates, ["delivered", "delivered", "delivered"]);

  await reply("7");
  const after = await card("7");
  assert.deepEqual(after.pendingTexts, []);
  assert.deepEqual(after.answered.map(m => m.text),
    ["the question the agent holds", "a first thought while the agent works", "and a second"]);
});

test("a reply before the hold runs out leaves the message it was never handed queued, and /wait hands it out after the hold", async t => {
  await send("7", "the question before the follow-up");
  const handed = await claim(30);
  assert.equal(handed.box, "7");
  await ack(handed);

  await typing("7");
  await send("7", "a follow-up typed while the agent works");
  const last = await typing("7");
  // the agent reads /fresh before its reply, as it must, and is handed nothing
  assert.deepEqual((await get("/fresh?owner=facilitator")).body.messages, []);
  await reply("7", "an answer to the question alone");

  // the reply answered what it was handed and nothing more
  const after = await card("7");
  assert.deepEqual(after.answered.map(m => m.text), ["the question before the follow-up"]);
  assert.deepEqual(after.pendingTexts, ["a follow-up typed while the agent works"]);
  assert.deepEqual(after.pendingStates, ["sent"]);
  assert.equal(after.state, "queued");
  assert.equal(after.queuePos, 1);
  assert.deepEqual((await get("/unread?owner=facilitator")).body, { queued: 1, claimed: 0 });

  // the follow-up waits on the card as a queued message, and goes out with the
  // card once the hold is out
  const said = await claim(30);
  assert.equal(said.box, "7");
  assert.deepEqual(said.messages, ["a follow-up typed while the agent works"]);
  onTime(t, said.at - last, "A");
  await answer(said);
  assert.deepEqual((await card("7")).answered.map(m => m.text), ["a follow-up typed while the agent works"]);
});

test("a spoken message goes out at once even with a typing report just before it, and the typed card beside it is still held 7 seconds", async t => {
  const waiting = listen(30);
  await sleep(200);
  // A is typed on and goes first in the queue; C is reported as typed on too,
  // then spoken to
  const sentA = await send("7", "a message typed on A");
  await typing("9");
  const spoken = await speak("9", "a message spoken on C");
  const said = await waiting.done;
  assert.equal(said.box, "9");
  assert.deepEqual(said.messages, ["a message spoken on C"]);
  assert.deepEqual(said.message_via, ["voice"]);
  t.diagnostic(`C came ${said.at - spoken} ms after the send began`);
  assert.ok(said.at - spoken < LATE_MS, `C came ${said.at - spoken} ms after the send began`);
  // and A kept its place, held as ever
  assert.equal(said.queued_after, 1);
  await answer(said);
  const typed = await claim(30);
  assert.equal(typed.box, "7");
  assert.deepEqual(typed.message_via, [null]);
  onTime(t, typed.at - sentA, "A");
  await answer(typed);
});

test("an agent holding the voice card gets a second spoken message from /fresh at once", async t => {
  await speak("9", "the spoken question the agent holds");
  const handed = await claim(30);
  assert.equal(handed.box, "9");
  await ack(handed);

  // a report on the voice card starts nothing either
  await typing("9");
  const spoken = await speak("9", "a second thing said while the agent works");
  const fresh = (await get("/fresh?owner=facilitator")).body;
  const took = Date.now() - spoken;
  assert.deepEqual(fresh, { box: "9", messages: ["a second thing said while the agent works"],
                            message_via: ["voice"] });
  t.diagnostic(`/fresh had it ${took} ms after the send began`);
  assert.ok(took < LATE_MS, `/fresh had it ${took} ms after the send began`);
  assert.deepEqual((await get("/unread?owner=facilitator")).body, { queued: 0, claimed: 2 });

  await reply("9");
  const after = await card("9");
  assert.deepEqual(after.pendingTexts, []);
  assert.deepEqual(after.answered.map(m => m.text),
    ["the spoken question the agent holds", "a second thing said while the agent works"]);
});
