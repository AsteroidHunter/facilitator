// where each sent message stands with the agent, as the board states it to the
// pages: sent while no agent has confirmed receiving it, delivered once the
// claim carrying it is confirmed through /ack (or /fresh folds it into such a
// claim), read once the agent has written back since receiving it (a progress
// note over its claim, or a note that took it toward the answer still to come),
// and gone into the reply's own batch once the reply lands. read through a real
// fixture server on a free port; the suite never touches port 8877. every card
// and message below is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ACK_GRACE_S = 1.5;   // ACK_GRACE in this fixture

let outer;
let app;
let port;
let origin;
let child;

function patch(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `fixture patch did not apply: ${from}`);
  return out;
}

async function startServer() {
  child = spawn("python3", [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}
async function post(route, body = "") {
  const answer = await api(route, { method: "POST", body });
  assert.equal(answer.status, 200, `${route}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}
// the card as the desktop reads it and as the phone reads it
async function card(id) {
  return (await api("/state")).body.boxes.find(b => b.id === id);
}
async function phoneCard(id) {
  return (await api("/m/state")).body.boxes.find(b => b.id === id);
}
// what the sent panel is drawn from: the queued words beside where each stands,
// and what a note has already taken toward the answer
async function marks(id) {
  const b = await card(id);
  return { texts: b.pendingTexts, states: b.pendingStates, noted: b.notedTexts };
}
async function claim(agent) {
  const got = await api(`/wait?owner=facilitator&timeout=3&agent=${agent}`);
  assert.ok(got.body.box, `no claim: ${JSON.stringify(got.body)}`);
  return got.body;
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-delivery-"));
  app = path.join(outer, "app");
  await mkdir(app);
  await mkdir(path.join(outer, "logs"));
  port = await require("./fixture-auth.cjs").freePortPair();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = patch(source, "ACK_GRACE = 90.0", `ACK_GRACE = ${ACK_GRACE_S}`);
  await writeFile(path.join(app, "server.py"), source);
  require("./fixture-auth.cjs").copyBridgeFiles(app);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "delivery fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      { id: "m1", bucket: "meta", title: "Invented first card", owner: "facilitator" },
      { id: "m2", bucket: "meta", title: "Invented second card", owner: "facilitator" },
      { id: "m3", bucket: "meta", title: "Invented third card", owner: "facilitator" },
    ],
  }));
  await startServer();
  // a board met for the first time cannot state what a card's first answer was
  // given (the upgrade rule for answered batches), so each card is answered once
  // before the tests, and every batch from then on is exact
  for (const id of ["m1", "m2", "m3"]) {
    await post(`/send?box=${id}`, "Invented warm up message.");
    const got = await claim("warmup");
    await post(`/ack?owner=facilitator&token=${got.ack}`);
    await post(`/reply?box=${got.box}`, "Invented warm up answer.");
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a message is sent until its claim is confirmed, delivered after, and read once the agent writes back", async () => {
  await post("/send?box=m1", "Invented first message.");
  assert.deepEqual(await marks("m1"), { texts: ["Invented first message."], states: ["sent"], noted: [] },
    "a message nobody has received is not marked sent");
  // handed over, but the listener has not confirmed it: still only sent
  const got = await claim("states");
  assert.equal(got.box, "m1");
  assert.deepEqual((await marks("m1")).states, ["sent"], "a hand-off nobody confirmed counts as delivered");
  // the listener's receipt
  await post(`/ack?owner=facilitator&token=${got.ack}`);
  assert.deepEqual((await marks("m1")).states, ["delivered"], "a confirmed claim does not mark its message delivered");
  // a message landing while the agent works is only sent, until /fresh hands it over
  await post("/send?box=m1", "Invented second message.");
  assert.deepEqual((await marks("m1")).states, ["delivered", "sent"]);
  const fresh = await api("/fresh?owner=facilitator");
  assert.deepEqual(fresh.body.messages, ["Invented second message."]);
  assert.deepEqual((await marks("m1")).states, ["delivered", "delivered"], "a message /fresh handed over is not delivered");
  // the agent writes back: everything its claim holds is read, and what lands after is not
  await post("/send?box=m1", "Invented third message.");
  await post("/progress?box=m1", "Invented progress words.");
  assert.deepEqual((await marks("m1")).states, ["read", "read", "sent"], "a progress note did not mark its claim read");
  await api("/fresh?owner=facilitator");
  assert.deepEqual((await marks("m1")).states, ["read", "read", "delivered"],
    "a message handed over after the progress note was taken for read");
  // another card of the lane is untouched by this claim
  await post("/send?box=m3", "Invented message on another card.");
  assert.deepEqual((await marks("m3")).states, ["sent"], "a claim on one card marked another card's message");
  // the reply takes all three into its own batch, and the queue is empty
  await post("/reply?box=m1", "Invented answer.");
  const after = await card("m1");
  assert.deepEqual(after.pendingTexts, []);
  assert.deepEqual(after.pendingStates, []);
  assert.ok(Array.isArray(after.answered), `the reply recorded no batch: ${JSON.stringify(after)}`);
  assert.deepEqual(after.answered.map(m => m.text),
    ["Invented first message.", "Invented second message.", "Invented third message."]);
  // clear the other card for the tests after this one
  const other = await claim("states");
  await post(`/ack?owner=facilitator&token=${other.ack}`);
  await post(`/reply?box=${other.box}`, "Invented answer to the other card.");
});

test("a note takes what its claim held off the queue as read, and the completed reply takes it", async () => {
  await post("/send?box=m2", "Invented message a note covers.");
  const got = await claim("notes");
  assert.equal(got.box, "m2");
  await post(`/ack?owner=facilitator&token=${got.ack}`);
  assert.deepEqual((await marks("m2")).states, ["delivered"]);
  await post("/note?box=m2", "Invented interim note.");
  assert.deepEqual(await marks("m2"), { texts: [], states: [], noted: ["Invented message a note covers."] },
    "a message a note took is not kept as read for the answer to come");
  // a later message is sent, and handed over by the next claim
  await post("/send?box=m2", "Invented message after the note.");
  assert.deepEqual(await marks("m2"), { texts: ["Invented message after the note."], states: ["sent"],
    noted: ["Invented message a note covers."] });
  const again = await claim("notes");
  assert.equal(again.box, "m2");
  await post(`/ack?owner=facilitator&token=${again.ack}`);
  assert.deepEqual((await marks("m2")).states, ["delivered"]);
  await post("/reply?box=m2", "Invented completed answer.");
  const after = await card("m2");
  assert.deepEqual(after.notedTexts, [], "the reply left the note's messages standing");
  assert.deepEqual(after.answered.map(m => m.text), ["Invented message a note covers.", "Invented message after the note."]);
});

test("a hand-off nobody confirms comes back sent, and the next confirmed claim delivers it", async () => {
  await post("/send?box=m3", "Invented message handed to a listener that never answers.");
  const lost = await claim("deaf");
  assert.equal(lost.box, "m3");
  assert.deepEqual((await marks("m3")).states, ["sent"]);
  // the ack clock brings the card back without a receipt
  const deadline = Date.now() + (ACK_GRACE_S + 6) * 1000;
  for (;;) {
    const st = (await api("/state")).body;
    if (st.busy.facilitator === null) break;
    assert.ok(Date.now() < deadline, "the unconfirmed hand-off never came back");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual((await marks("m3")).states, ["sent"], "an unconfirmed hand-off left its message delivered");
  const got = await claim("real");
  assert.equal(got.box, "m3");
  await post(`/ack?owner=facilitator&token=${got.ack}`);
  assert.deepEqual((await marks("m3")).states, ["delivered"]);
  await post("/reply?box=m3", "Invented answer after the bounce.");
});

test("the phone's reading carries the same marks, and a receipt moves its revision", async () => {
  await post("/send?box=m1", "Invented message the phone watches.");
  const before = (await api("/m/state")).body;
  const one = before.boxes.find(b => b.id === "m1");
  assert.deepEqual(one.pendingStates, ["sent"]);
  assert.deepEqual(one.notedTexts, []);
  const got = await claim("phone");
  await post(`/ack?owner=facilitator&token=${got.ack}`);
  // the phone reads by revision, so a receipt it could not see would never be drawn
  const later = (await api(`/m/state?since=${before.rev}`)).body;
  assert.equal(later.changed, true, "the receipt did not move the revision the phone reads by");
  assert.deepEqual(later.boxes.find(b => b.id === "m1").pendingStates, ["delivered"]);
  assert.deepEqual((await phoneCard("m1")).pendingStates, (await card("m1")).pendingStates,
    "the phone and the desktop disagree about a message");
  await post("/reply?box=m1", "Invented answer the phone sees.");
});
