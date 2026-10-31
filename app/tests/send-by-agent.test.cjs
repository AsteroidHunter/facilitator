// who sent a message, apart from how it arrived: every POST /send an agent
// makes (no browser headers, as curl and the scripts send) is stored as an
// agent's, with or without by=agent, and with agent=NAME when it names
// itself; the board's own pages and the phone send the reader's own words,
// and a page's by=agent is kept as it always was. the sender is carried to
// every place the message goes: the pages' readings (pendingBy), /wait and
// /fresh (message_by, message_agent), the answered batch, the transcript row,
// /thread and the history. the reader's own messages carry none of it. the
// board is the fixture copy on a free port, with a phone password so the
// phone's door can be signed in to; every card and message is invented
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { readFile, writeFile } = require("node:fs/promises");
const { request } = require("node:http");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PASS = "sender-fixture-pass-7";
const SEED = { title: "sender board", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
  { id: "7", bucket: "now", title: "Card spoken to and typed on", owner: "facilitator" },
  { id: "8", bucket: "now", title: "Card for the receipts", owner: "facilitator" },
  // lanes of their own, so their claims are not behind the cards above
  { id: "9", bucket: "now", title: "Card another project's agent writes on", owner: "pastureland" },
  { id: "10", bucket: "now", title: "Card typed on at the Mac and the phone", owner: "orchard" },
] };

let board;
// a seeded card's first answer is recorded as unknown (the answered batches'
// upgrade), so card 7 is answered once first. the reader speaks to it, which
// also makes it a voice card that is never held for typing
const WARM = "an invented first message spoken by the reader";
before(async () => {
  board = await startBoard({ seed: SEED, prepare: async ({ app }) => {
    execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
    // these cases are about the sender, not the typing hold (typing-hold.test.cjs),
    // so a message sent here is free to go out at once
    const file = path.join(app, "server.py");
    const source = await readFile(file, "utf8");
    const patched = source.replace("TYPING_HOLD = 3.5", "TYPING_HOLD = 0.0");
    assert.notEqual(patched, source, "test server typing hold was not patched");
    await writeFile(file, patched);
  } });
  await typed("/send?box=7&via=voice", WARM);
  const handed = (await get("/wait?owner=facilitator&timeout=5&agent=claude")).body;
  assert.equal(handed.box, "7");
  assert.equal((await post(`/ack?owner=facilitator&token=${handed.ack}`)).status, 200);
  assert.equal((await post("/reply?box=7", "an invented answer before the test")).status, 200);
});
after(async () => { if (board) await board.stop(); });

// an agent's request: no browser headers, as curl and the scripts send
async function post(route, body = "") {
  const response = await fetch(board.origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}
// the board's own page, with the headers a browser puts on every write
async function page(route, body = "") {
  const r = await board.call("POST", route, body);
  return { status: r.status, body: JSON.parse(r.text) };
}
// the phone, signed in through its own door on the port above the board's
async function phone(route, body = "") {
  const bridge = board.port + 1, origin = `http://127.0.0.1:${bridge}`;
  const call = (method, where, bytes, headers) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: bridge, method, path: where,
      headers: { Host: `127.0.0.1:${bridge}`, Origin: origin, ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
  if (!board.phoneCookie) {
    const login = await call("POST", "/auth/login", JSON.stringify({ password: PASS }), {});
    assert.equal(login.status, 200, login.text);
    board.phoneCookie = login.headers["set-cookie"][0].split(";")[0];
  }
  const r = await call("POST", route, body, { Cookie: board.phoneCookie });
  return { status: r.status, body: JSON.parse(r.text) };
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
const landed = async (said, route) => {
  assert.equal(said.status, 200, `${route} was refused: ${JSON.stringify(said.body)}`);
  return said.body;
};
// sent by an agent, by the board's own page, by the phone
const sent = async (route, text) => landed(await post(route, text), route);
const typed = async (route, text) => landed(await page(route, text), route);
const fromPhone = async (route, text) => landed(await phone(route, text), route);

const OWN = "an invented message typed on the card";
const SPOKEN = "an invented message the voice assistant sent";
const NAMELESS = "an invented message from an agent that gave no name";
const STRAY = "an invented message with a by the board does not keep";
const LONELY = "an invented message naming an agent without by";
const LONG = "an invented message from an agent with a long name";

test("a send with by=agent is stored with its sender, and every other send is the reader's own", async () => {
  await sent("/send?box=7&via=voice&by=agent&agent=voice-assistant", SPOKEN);
  await typed("/send?box=7", OWN);
  await sent("/send?box=7&by=agent", NAMELESS);
  await typed("/send?box=7&by=someone&agent=other", STRAY);
  await typed("/send?box=7&agent=lonely", LONELY);
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
  await typed("/send?box=7", "an invented message typed while the agent works");
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
  await typed("/send?box=7&via=voice", "an invented message spoken by the reader");
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
  assert.equal((await page(`/send?box=8&op=${op}`, "an invented message sent once")).status, 409,
    "the same id from the reader was taken for the agent's send");
  assert.equal((await post(`/send?box=8&by=agent&agent=other&op=${op}`, "an invented message sent once")).status, 409);
  // the reader's own send under an id is deduplicated as it always was
  const own = await typed("/send?box=8&op=sender-receipt-2", "an invented message typed once");
  const ownAgain = await page("/send?box=8&op=sender-receipt-2", "an invented message typed once");
  assert.equal(ownAgain.body.replayed, true);
  assert.equal(ownAgain.body.mid, own.mid);
  // and an agent's send that leaves by off, retried under its id, lands once
  const plain = await sent("/send?box=8&op=sender-receipt-3", "an invented message an agent retried");
  const plainAgain = await post("/send?box=8&op=sender-receipt-3", "an invented message an agent retried");
  assert.equal(plainAgain.status, 200);
  assert.equal(plainAgain.body.replayed, true);
  assert.equal(plainAgain.body.mid, plain.mid);
  assert.deepEqual((await stored("8")).pending.map(m => m.by || null), ["agent", null, "agent"]);
});

const PLAIN = "an invented order another project's agent sent with no by";
const NAMED = "an invented message an agent signed without by";
const ODD = "an invented message an agent sent with a by the board does not keep";

test("every send an agent makes is an agent's, by=agent or not, and keeps the name it gives", async () => {
  await sent("/send?box=9", PLAIN);
  await sent("/send?box=9&agent=lane-a-agent", NAMED);
  await sent("/send?box=9&by=someone&agent=other", ODD);

  const pending = (await stored("9")).pending.map(({ text, by, agent }) => ({ text, by, agent }));
  assert.deepEqual(pending, [
    { text: PLAIN, by: "agent", agent: undefined },
    { text: NAMED, by: "agent", agent: "lane-a-agent" },
    { text: ODD, by: "agent", agent: "other" },
  ], "an agent's send was stored as the reader's own");
  const written = (await rows("9")).map(({ text, by, agent }) => ({ text, by, agent }));
  assert.deepEqual(written, pending);
  assert.deepEqual((await get("/state")).body.boxes.find(b => b.id === "9").pendingBy, ["agent", "agent", "agent"]);
  assert.deepEqual((await get("/m/state")).body.boxes.find(b => b.id === "9").pendingBy, ["agent", "agent", "agent"]);

  // the lane's agent is told none of them is the reader's
  const handed = (await get("/wait?owner=pastureland&timeout=5&agent=claude")).body;
  assert.equal(handed.box, "9");
  assert.deepEqual(handed.message_by, ["agent", "agent", "agent"]);
  assert.deepEqual(handed.message_agent, [null, "lane-a-agent", "other"]);
  assert.equal((await post(`/ack?owner=pastureland&token=${handed.ack}`)).status, 200);
  await sent("/send?box=9", "an invented message an agent sent mid-work");
  const fresh = (await get("/fresh?owner=pastureland")).body;
  assert.deepEqual([fresh.messages, fresh.message_by], [["an invented message an agent sent mid-work"], ["agent"]]);
  assert.equal((await post("/reply?box=9", "an invented answer from the lane's agent")).status, 200);
});

test("the board's own page and the phone send the reader's own words", async () => {
  await typed("/send?box=10", "an invented message typed on the Mac board");
  await typed("/send?box=10&via=mini", "an invented message typed on the small card");
  await fromPhone("/send?box=10", "an invented message typed on the phone");
  await fromPhone("/send?box=10&op=sender-phone-1", "an invented message the phone sent under an id");
  const pending = (await stored("10")).pending;
  assert.deepEqual(pending.map(m => m.text), ["an invented message typed on the Mac board",
    "an invented message typed on the small card", "an invented message typed on the phone",
    "an invented message the phone sent under an id"]);
  for (const m of pending)
    assert.ok(!("by" in m) && !("agent" in m), `the reader's own message carries a sender: ${JSON.stringify(m)}`);
  const handed = (await get("/wait?owner=orchard&timeout=5&agent=claude")).body;
  assert.equal(handed.box, "10");
  assert.deepEqual(handed.message_by, [null, null, null, null]);
  assert.equal((await post(`/ack?owner=orchard&token=${handed.ack}`)).status, 200);
  assert.equal((await post("/reply?box=10", "an invented answer from the lane's agent")).status, 200);
});
