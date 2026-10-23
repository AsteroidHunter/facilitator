// who sent a message, apart from how it arrived: POST /send takes by=agent and
// agent=NAME from an agent that puts a message on a card for the reader (a
// voice or text assistant), stores them on the message, and carries them to
// every place the message goes: the pages' readings (pendingBy), /wait and
// /fresh (message_by, message_agent), the answered batch, the transcript row,
// /thread and the history. the reader's own messages carry none of it. the
// board is the fixture copy on a free port; every card and message is invented
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const SEED = { title: "sender board", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
  { id: "7", bucket: "now", title: "Card spoken to and typed on", owner: "facilitator" },
  { id: "8", bucket: "now", title: "Card for the receipts", owner: "facilitator" },
] };

let board;
// a seeded card's first answer is recorded as unknown (the answered batches'
// upgrade), so card 7 is answered once first. the reader speaks to it, which
// also makes it a voice card that is never held for typing
const WARM = "an invented first message spoken by the reader";
before(async () => {
  board = await startBoard({ seed: SEED });
  await sent("/send?box=7&via=voice", WARM);
  const handed = (await get("/wait?owner=facilitator&timeout=5&agent=claude")).body;
  assert.equal(handed.box, "7");
  assert.equal((await post(`/ack?owner=facilitator&token=${handed.ack}`)).status, 200);
  assert.equal((await post("/reply?box=7", "an invented answer before the test")).status, 200);
});
after(async () => { if (board) await board.stop(); });

async function post(route, body = "") {
  const response = await fetch(board.origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}
async function get(route) {
  const response = await fetch(board.origin + route);
  return { status: response.status, body: await response.json() };
}
async function stored(box) {
  const state = JSON.parse(await readFile(path.join(board.data, "state.json"), "utf8"));
  return state.boxes.find(b => b.id === box);
}
// the transcript's user rows on a card, the warm-up's left out
async function rows(box) {
  return (await readFile(path.join(board.data, "transcript.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.box === box && row.kind === "user" && row.text !== WARM);
}
const sent = async (route, text) => {
  const said = await post(route, text);
  assert.equal(said.status, 200, `${route} was refused: ${JSON.stringify(said.body)}`);
  return said.body;
};

const OWN = "an invented message typed on the card";
const SPOKEN = "an invented message the voice assistant sent";
const NAMELESS = "an invented message from an agent that gave no name";
const STRAY = "an invented message with a by the board does not keep";
const LONELY = "an invented message naming an agent without by";
const LONG = "an invented message from an agent with a long name";

test("a send with by=agent is stored with its sender, and every other send is the reader's own", async () => {
  await sent("/send?box=7&via=voice&by=agent&agent=voice-assistant", SPOKEN);
  await sent("/send?box=7", OWN);
  await sent("/send?box=7&by=agent", NAMELESS);
  await sent("/send?box=7&by=someone&agent=other", STRAY);
  await sent("/send?box=7&agent=lonely", LONELY);
  await sent("/send?box=7&by=agent&agent=" + "a".repeat(30), LONG);

  const pending = (await stored("7")).pending.map(({ text, via, by, agent }) => ({ text, via, by, agent }));
  assert.deepEqual(pending, [
    { text: SPOKEN, via: "voice", by: "agent", agent: "voice-assistant" },
    { text: OWN, via: undefined, by: undefined, agent: undefined },
    { text: NAMELESS, via: undefined, by: "agent", agent: undefined },
    { text: STRAY, via: undefined, by: undefined, agent: undefined },
    { text: LONELY, via: undefined, by: undefined, agent: undefined },
    { text: LONG, via: undefined, by: "agent", agent: "a".repeat(24) },
  ], "the stored messages do not say who sent each, or say it of the reader's own");
  for (const m of (await stored("7")).pending.filter(one => !one.by))
    assert.ok(!("by" in m) && !("agent" in m), `the reader's own message carries a sender: ${JSON.stringify(m)}`);

  // the transcript row says the same, and the reader's rows say nothing
  const written = (await rows("7")).map(({ text, by, agent }) => ({ text, by, agent }));
  assert.deepEqual(written, pending.map(({ text, by, agent }) => ({ text, by, agent })));

  // both pages' readings carry the marker beside the words, one to one
  const want = ["agent", null, "agent", null, null, "agent"];
  const desk = (await get("/state")).body.boxes.find(b => b.id === "7");
  assert.deepEqual(desk.pendingTexts, pending.map(m => m.text));
  assert.deepEqual(desk.pendingBy, want, "the Mac board's reading does not say which messages an agent sent");
  const phone = (await get("/m/state")).body.boxes.find(b => b.id === "7");
  assert.deepEqual(phone.pendingBy, want, "the phone's reading does not say which messages an agent sent");
});

test("the lane's agent is told which messages an agent sent, in /wait, /fresh, the answer and the history", async () => {
  // no card held: the empty answer has the four lists
  assert.deepEqual((await get("/fresh?owner=facilitator")).body,
    { messages: [], message_via: [], message_by: [], message_agent: [] });
  const handed = (await get("/wait?owner=facilitator&timeout=5&agent=claude")).body;
  assert.equal(handed.box, "7");
  assert.deepEqual(handed.message_via, ["voice", null, null, null, null, null]);
  assert.deepEqual(handed.message_by, ["agent", null, "agent", null, null, "agent"]);
  assert.deepEqual(handed.message_agent, ["voice-assistant", null, null, null, null, "a".repeat(24)]);
  assert.equal((await post(`/ack?owner=facilitator&token=${handed.ack}`)).status, 200);

  // nothing new yet: the empty answer has the same four lists
  assert.deepEqual((await get("/fresh?owner=facilitator")).body,
    { box: "7", messages: [], message_via: [], message_by: [], message_agent: [] });
  // mid-work, one from the reader and one from a text assistant
  await sent("/send?box=7", "an invented message typed while the agent works");
  await sent("/send?box=7&by=agent&agent=text-assistant", "an invented message a text assistant sent");
  assert.deepEqual((await get("/fresh?owner=facilitator")).body, {
    box: "7", messages: ["an invented message typed while the agent works", "an invented message a text assistant sent"],
    message_via: [null, null], message_by: [null, "agent"], message_agent: [null, "text-assistant"],
  });

  // the answer's batch keeps the sender on the agent's messages and on no other
  assert.equal((await post("/reply?box=7", "an invented first answer")).status, 200);
  const senders = batch => batch.map(m => [m.by, m.agent]);
  const live = (await get("/state")).body.boxes.find(b => b.id === "7");
  const first = [["agent", "voice-assistant"], [undefined, undefined], ["agent", undefined], [undefined, undefined],
    [undefined, undefined], ["agent", "a".repeat(24)], [undefined, undefined], ["agent", "text-assistant"]];
  assert.deepEqual(senders(live.answered), first, "the batch over the answer lost who sent its messages");
  assert.deepEqual(senders((await get("/m/state")).body.boxes.find(b => b.id === "7").answered), first);
  assert.deepEqual(live.pendingBy, []);

  // /thread reads the transcript's rows the same way
  const thread = (await get("/thread?box=7&n=60")).body.messages.filter(m => m.kind === "user" && m.text !== WARM);
  assert.deepEqual(senders(thread), first);

  // a second answer puts the first in the history, its batch's senders with it
  await sent("/send?box=7&via=voice", "an invented message spoken by the reader");
  const again = (await get("/wait?owner=facilitator&timeout=5&agent=claude")).body;
  assert.deepEqual(again.message_via, ["voice"]);
  assert.deepEqual(again.message_by, [null], "the reader's spoken words were taken for an agent's");
  assert.equal((await post(`/ack?owner=facilitator&token=${again.ack}`)).status, 200);
  assert.equal((await post("/reply?box=7", "an invented second answer")).status, 200);
  const history = (await get("/history?box=7")).body;
  assert.deepEqual(senders(history.replyMeta.at(-1).answered), first, "the history lost who sent the older batch");
  const now = (await get("/state")).body.boxes.find(b => b.id === "7");
  assert.deepEqual(senders(now.answered), [[undefined, undefined]]);
});

test("an operation id names its sender too: the same send again is answered from its receipt, another sender is refused", async () => {
  const op = "sender-receipt-1";
  const first = await sent(`/send?box=8&by=agent&agent=voice-assistant&op=${op}`, "an invented message sent once");
  const again = await post(`/send?box=8&by=agent&agent=voice-assistant&op=${op}`, "an invented message sent once");
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.mid, first.mid);
  assert.equal((await post(`/send?box=8&op=${op}`, "an invented message sent once")).status, 409,
    "the same id with the sender left off was taken for the same send");
  assert.equal((await post(`/send?box=8&by=agent&agent=other&op=${op}`, "an invented message sent once")).status, 409);
  // the reader's own send under an id is deduplicated as it always was
  const own = await sent("/send?box=8&op=sender-receipt-2", "an invented message typed once");
  const ownAgain = await post("/send?box=8&op=sender-receipt-2", "an invented message typed once");
  assert.equal(ownAgain.body.replayed, true);
  assert.equal(ownAgain.body.mid, own.mid);
  assert.deepEqual((await stored("8")).pending.map(m => m.by || null), ["agent", null]);
});
