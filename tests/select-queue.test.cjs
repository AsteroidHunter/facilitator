// The queue a lane reads and chooses from: rows with no request text, a
// selection that reserves through the existing claim, a delivery that confirms
// nothing until the client says the body arrived, the two replay classes, the
// holder record, and work registered against a card. An auto lane is checked
// alongside to prove nothing about today's behaviour moved.
//
// The fixture pattern is the one the other server suites use: a patched copy of
// server.py on a free port, logs redirected into the fixture, invented cards,
// and no contact with the live board. The suite never touches port 8877, and
// the clocks are patched down so a 90 second lease and a 180 second holder
// expiry can be waited out in seconds.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ACK_GRACE_S = 2;      // the unconfirmed lease in this fixture
const HOLDER_IDLE_S = 2;    // the holder expiry in this fixture
const BG_STALE_S = 3;       // how long a registered job stays green without a beat
const LANE = "facilitator";
const AUTO_LANE = "pastureland";

let outer;
let app;
let port;
let origin;
let child;
let ids = 0;

const op = () => `op-${String(++ids).padStart(6, "0")}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const chosen = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return chosen;
}

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
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await sleep(25);
  }
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  const body = response.headers.get("content-type")?.includes("json")
    ? await response.json() : await response.text();
  return { status: response.status, body };
}

const post = (route, body) => api(route, { method: "POST", body });
const state = async () => (await api("/state")).body;
const card = async id => (await state()).boxes.find(b => b.id === id);

async function queue(extra = "") {
  return api(`/queue?owner=${LANE}&session=s-one${extra}`);
}

async function rowOf(id) {
  const listed = (await queue("&include=done,parked,green")).body;
  const found = listed.cards.find(c => c.box === id);
  assert.ok(found, `card ${id} is not in the listing`);
  return found;
}

async function hold(session = "s-one", extra = "") {
  return post(`/hold?owner=${LANE}&session=${session}&agent=claude&machine=studio${extra}`);
}

async function select(id, session = "s-one", operation = op()) {
  const row = (await rowOf(id)).row;
  return { operation, row,
           ...await post(`/select?owner=${LANE}&session=${session}&box=${id}&op=${operation}&row=${row}`) };
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-select-"));
  app = path.join(outer, "app");
  await mkdir(app);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = patch(source, "ACK_GRACE = 90.0", `ACK_GRACE = ${ACK_GRACE_S}`);
  source = patch(source, "HOLDER_IDLE = 180.0", `HOLDER_IDLE = ${HOLDER_IDLE_S}`);
  source = patch(source, "BG_STALE = 75.0", `BG_STALE = ${BG_STALE_S}`);
  await writeFile(path.join(app, "server.py"), source);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "select fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: LANE },
      { id: "m1", bucket: "work", title: "Kettle descaling schedule", owner: LANE },
      { id: "m2", bucket: "work", title: "Repaint the garden gate", owner: LANE },
      { id: "m3", bucket: "work", title: "Sort the seed packets", owner: LANE },
      { id: "m4", bucket: "work", title: "Shed shelf brackets", owner: LANE },
      { id: "p1", bucket: "work", title: "Another lane's card", owner: AUTO_LANE },
    ],
  }));
  await startServer();
  await post(`/mode?owner=${LANE}&mode=select`);
  assert.equal((await hold()).status, 200);
});

after(async () => {
  await stopServer();
  if (outer) await rm(outer, { recursive: true, force: true });
});

// ---- the listing ------------------------------------------------------------

test("rows carry what changes an answer and never the request itself", async () => {
  const secret = "the kettle is furred up and the filter needs replacing";
  assert.equal((await post(`/send?box=m1`, secret)).status, 200);
  assert.equal((await post(`/send?box=m2`, "the gate has gone grey")).status, 200);
  const listed = await queue();
  assert.equal(listed.status, 200);
  assert.equal(listed.body.mode, "select");
  assert.ok(!JSON.stringify(listed.body).includes(secret), "the listing carried a message");
  assert.ok(!JSON.stringify(listed.body).includes("gone grey"), "the listing carried a message");
  const m1 = listed.body.cards.find(c => c.box === "m1");
  assert.equal(m1.title, "Kettle descaling schedule");
  assert.equal(m1.waiting, 1);
  assert.equal(m1.state, "queued");
  assert.equal(m1.starved, false);
  assert.deepEqual(m1.via, ["big"]);
  // oldest first, and only this lane's cards
  assert.deepEqual(listed.body.cards.map(c => c.box), ["m1", "m2"]);
  assert.equal(listed.body.cards.some(c => c.box === "p1"), false);
});

test("the listing agrees with the unread count", async () => {
  const listed = (await queue()).body;
  const unread = (await api(`/unread?owner=${LANE}`)).body;
  const waiting = listed.cards.reduce((sum, c) => sum + c.waiting, 0);
  assert.equal(waiting, unread.queued, "the listing and the unread count disagree");
});

// ---- choosing ---------------------------------------------------------------

test("a selection reserves the card and turns it green through the existing mask", async () => {
  const chosen = await select("m1");
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.equal(chosen.body.box, "m1");
  assert.equal(typeof chosen.body.reservation, "string");
  assert.equal(typeof chosen.body.hold, "string");
  assert.equal(chosen.body.messages, undefined, "the selection carried message text");
  // the colour comes from the claim mask the auto path already uses
  assert.equal((await card("m1")).state, "working");
  // and the card has left the listing, reported once under held instead
  const listed = (await queue()).body;
  assert.equal(listed.cards.some(c => c.box === "m1"), false);
  assert.equal(listed.held.box, "m1");
  assert.equal(listed.held.acknowledged, false);
});

test("a second reservation is refused while one is held", async () => {
  const second = await select("m2");
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "already reserved");
  assert.equal(second.body.box, "m1");
});

test("a card from another lane and a card that does not exist answer the same refusal", async () => {
  // routing validation, not protection: an agent with local access can still
  // call the board directly, and this check does not stop it
  const other = await post(`/select?owner=${LANE}&session=s-one&box=p1&op=${op()}&row=abc123abc123`);
  const missing = await post(`/select?owner=${LANE}&session=s-one&box=nope&op=${op()}&row=abc123abc123`);
  assert.equal(other.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(other.body, missing.body);
});

// ---- opening, and the receipt that follows it -------------------------------

test("opening hands over the messages and confirms nothing", async () => {
  const opened = await post(`/open?owner=${LANE}&session=s-one&box=m1&op=${op()}`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.messages.length, 1);
  assert.match(opened.body.messages[0].text, /furred up/);
  assert.equal(opened.body.messages[0].role, "human");
  assert.equal(opened.body.messages[0].read_before, false);
  // the reservation is still provisional, so the short lease is still running
  assert.equal((await queue()).body.held.acknowledged, false);
  globalThis.__delivery = opened.body.delivery;
});

test("an unconfirmed reservation comes back on the short lease, exactly as a claim does", async () => {
  await sleep((ACK_GRACE_S + 1) * 1000);
  await queue();   // the lazy clock runs where the board reading runs
  const listed = (await queue()).body;
  assert.equal(listed.held, null, "the lease did not release the reservation");
  assert.ok(listed.cards.some(c => c.box === "m1"), "the card did not go back to the queue");
  assert.equal((await card("m1")).state, "queued");
});

test("a receipt for a delivery abandoned before it was acknowledged is refused", async () => {
  const late = await post(`/opened?owner=${LANE}&session=s-one&delivery=${globalThis.__delivery}&op=${op()}&route=tool`);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "delivery is stale");
  assert.equal(late.body.row.box, "m1");
});

test("a receipt confirms the claim and records access with the route that carried it", async () => {
  const chosen = await select("m1");
  assert.equal(chosen.status, 200);
  const opened = await post(`/open?owner=${LANE}&session=s-one&box=m1&op=${op()}`);
  const did = opened.body.delivery;
  const receipt = await post(`/opened?owner=${LANE}&session=s-one&delivery=${did}&op=${op()}&route=tool`);
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.route, "tool");
  assert.ok(receipt.body.acked_ts > 0);
  assert.equal((await queue()).body.held.acknowledged, true);
  // and the card now says a delivery of these messages was acknowledged
  await sleep((ACK_GRACE_S + 1) * 1000);
  await queue();
  assert.equal((await queue()).body.held.box, "m1", "an acknowledged claim was released by the lease");
  globalThis.__acked = did;
});

test("a repeat receipt reports the recorded fact and creates no claim", async () => {
  const again = await post(`/opened?owner=${LANE}&session=s-one&delivery=${globalThis.__acked}&op=${op()}&route=tool`);
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(again.body.stale_epoch, false);
});

test("an open whose answer was lost replays the same body, and the receipt holds no words", async () => {
  const operation = op();
  const route = `/open?owner=${LANE}&session=s-one&box=m1&op=${operation}`;
  const first = await post(route);
  assert.equal(first.status, 200);
  const again = await post(route);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.delivery, first.body.delivery, "the replay prepared a second delivery");
  assert.deepEqual(again.body.messages.map(m => m.text), first.body.messages.map(m => m.text));
  // the words live in the card and the transcript. A receipt is kept for days
  // and has no business holding a second copy of them
  const saved = JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
  assert.ok(!JSON.stringify(saved.ops[operation]).includes("furred up"),
            "the open receipt carried the message text");
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${first.body.delivery}&op=${op()}&route=tool`)).status, 200);
});

// These three work on a card of their own and hand the lane back holding what
// it held before, so the rest of the suite reads as one story.
test("a message landing between selection and opening is delivered once, not twice", async () => {
  // the race the plan cares about: the reservation handed over what was waiting
  // then, and anything later belongs to a fresh delivery with a receipt of its
  // own. Delivering it in both is the same words twice under two receipts
  const wasHeld = (await queue()).body.held?.box;
  if (wasHeld) assert.equal((await post(`/release?owner=${LANE}&session=s-one&box=${wasHeld}&op=${op()}`)).status, 200);
  assert.equal((await post(`/send?box=m4`, "first: two brackets are missing")).status, 200);
  assert.equal((await select("m4")).status, 200);
  assert.equal((await post(`/send?box=m4`, "second: and one is bent")).status, 200);
  const first = await post(`/open?owner=${LANE}&session=s-one&box=m4&op=${op()}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.messages.map(m => m.text), ["first: two brackets are missing"],
                   "the initial delivery carried a message that arrived after the reservation");
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${first.body.delivery}&op=${op()}&route=tool`)).status, 200);
  const later = await post(`/open?owner=${LANE}&session=s-one&box=m4&op=${op()}&fresh=1`);
  assert.equal(later.status, 200);
  assert.deepEqual(later.body.messages.map(m => m.text), ["second: and one is bent"]);
  // the two deliveries share no message at all
  const both = [...first.body.messages, ...later.body.messages].map(m => m.mid);
  assert.equal(new Set(both).size, both.length, "one message was carried by two deliveries");
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${later.body.delivery}&op=${op()}&route=tool`)).status, 200);
});

test("a replay of an open describes its messages exactly as the first answer did", async () => {
  assert.equal((await post(`/release?owner=${LANE}&session=s-one&box=m4&op=${op()}`)).status, 200);
  assert.equal((await post(`/dismiss?box=m4`)).status, 200);
  assert.equal((await post(`/send?box=m4`, "the bent one needs replacing too")).status, 200);
  assert.equal((await select("m4")).status, 200);
  const operation = op();
  const route = `/open?owner=${LANE}&session=s-one&box=m4&op=${operation}`;
  const first = await post(route);
  assert.equal(first.status, 200);
  assert.equal(first.body.messages[0].read_before, false, "this message had been acknowledged before");
  assert.equal(first.body.messages[0].first_acked_ts, null);
  // the receipt sets the access time on the card. A replay of this operation
  // must still answer the body it prepared, not a description of the card now
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${first.body.delivery}&op=${op()}&route=tool`)).status, 200);
  const again = await post(route);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.deepEqual(again.body.messages, first.body.messages,
                   "the replay described the messages differently from the answer it replays");
});

test("a delivery that can no longer be rebuilt whole is a conflict, never a short body", async () => {
  const operation = op();
  const opened = await post(`/open?owner=${LANE}&session=s-one&box=m4&op=${operation}`);
  assert.equal(opened.status, 200);
  assert.ok(opened.body.messages.length >= 1);
  // dismissing drops the queued messages, so the body behind that operation can
  // no longer be assembled from the card
  assert.equal((await post(`/dismiss?box=m4`)).status, 200);
  const replay = await post(`/open?owner=${LANE}&session=s-one&box=m4&op=${operation}`);
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(replay.body.error, "delivery gone");
  // and the lane is handed back holding what it held before these three
  assert.equal((await select("m1")).status, 200);
  const opened1 = await post(`/open?owner=${LANE}&session=s-one&box=m1&op=${op()}`);
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${opened1.body.delivery}&op=${op()}&route=tool`)).status, 200);
});

test("mid-work messages arrive as their own delivery", async () => {
  assert.equal((await post(`/send?box=m1`, "one more thing about the kettle")).status, 200);
  const fresh = await post(`/open?owner=${LANE}&session=s-one&box=m1&op=${op()}&fresh=1`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.messages.length, 1, "fresh handed over the wrong count");
  assert.match(fresh.body.messages[0].text, /one more thing/);
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${fresh.body.delivery}&op=${op()}&route=tool`)).status, 200);
});

// ---- giving the card back ---------------------------------------------------

test("a release returns the card and replays its own success", async () => {
  // read from the saved board rather than the listing: the reserved card is
  // deliberately not a row, it is reported once under held
  const saved = JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
  const passedBefore = saved.boxes.find(b => b.id === "m1").passed_over ?? 0;
  const operation = op();
  const first = await post(`/release?owner=${LANE}&session=s-one&box=m1&op=${operation}&reason=not+now`);
  assert.equal(first.status, 200);
  assert.equal((await queue()).body.held, null);
  assert.ok((await queue()).body.cards.some(c => c.box === "m1"));
  // the reservation it removed is gone, and the receipt still answers
  const replay = await post(`/release?owner=${LANE}&session=s-one&box=m1&op=${operation}&reason=not+now`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  // one release, one more pass over, and the replay adds none of its own
  assert.equal((await rowOf("m1")).passed_over, passedBefore + 1);
});

// ---- the row tag ------------------------------------------------------------

test("a new message on the chosen card moves its row and the choice is refused", async () => {
  const stale = (await rowOf("m2")).row;
  assert.equal((await post(`/send?box=m2`, "and the hinges squeak")).status, 200);
  const refused = await post(`/select?owner=${LANE}&session=s-one&box=m2&op=${op()}&row=${stale}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "row moved");
  assert.equal(refused.body.row.waiting, 2);
  // the fresh row works
  const chosen = await select("m2");
  assert.equal(chosen.status, 200);
  assert.equal((await post(`/release?owner=${LANE}&session=s-one&box=m2&op=${op()}`)).status, 200);
});

test("a queue change on another card in the lane still allows the choice", async () => {
  const row = (await rowOf("m2")).row;
  assert.equal((await post(`/send?box=m3`, "the packets are all mixed up")).status, 200);
  const chosen = await post(`/select?owner=${LANE}&session=s-one&box=m2&op=${op()}&row=${row}`);
  assert.equal(chosen.status, 200, "another card moving invalidated this choice");
  assert.equal((await post(`/release?owner=${LANE}&session=s-one&box=m2&op=${op()}`)).status, 200);
});

test("a card with nothing waiting cannot be chosen", async () => {
  // it is not in the listing at all, which is why the row tag cannot be the
  // thing that refuses it: the route says what is actually wrong
  assert.equal((await queue()).body.cards.some(c => c.box === "0"), false);
  const empty = await post(`/select?owner=${LANE}&session=s-one&box=0&op=${op()}&row=abc123abc123`);
  assert.equal(empty.status, 410);
  assert.equal(empty.body.error, "nothing waiting");
});

// ---- work registered against a card -----------------------------------------

test("ending one of two jobs keeps the card green and the last one clears it", async () => {
  assert.equal((await post(`/work/start?owner=${LANE}&session=s-one&box=m3&op=${op()}&job=j-one&task=t12`)).status, 200);
  assert.equal((await card("m3")).state, "working");
  assert.deepEqual((await card("m3")).work, ["j-one"]);
  assert.equal((await post(`/work/start?owner=${LANE}&session=s-one&box=m3&op=${op()}&job=j-two`)).status, 200);
  assert.equal((await post(`/work/end?owner=${LANE}&session=s-one&box=m3&op=${op()}&job=j-one`)).status, 200);
  assert.equal((await card("m3")).state, "working", "ending one job took the other one's green");
  assert.deepEqual((await card("m3")).work, ["j-two"]);
  assert.equal((await post(`/work/end?owner=${LANE}&session=s-one&box=m3&op=${op()}&job=j-two`)).status, 200);
  assert.deepEqual((await card("m3")).work, []);
  assert.notEqual((await card("m3")).state, "working", "the last job ending left the card green");
});

test("a job that dies without an end is cleared by the existing heartbeat expiry", async () => {
  assert.equal((await post(`/work/start?owner=${LANE}&session=s-one&box=m3&op=${op()}&job=j-lost`)).status, 200);
  assert.equal((await card("m3")).state, "working");
  await sleep((BG_STALE_S + 1) * 1000);
  await state();   // the sweep runs where the board reading runs
  assert.notEqual((await card("m3")).state, "working", "the expiry did not clear a dead job");
  assert.equal((await post(`/work/end?owner=${LANE}&session=s-one&box=m3&op=${op()}&job=j-lost`)).status, 200);
});

// ---- who is serving the lane ------------------------------------------------

test("a second connection is told who holds the lane", async () => {
  const other = await hold("s-two");
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "lane already held");
  assert.equal(other.body.agent, "claude");
  assert.equal(other.body.machine, "studio");
  assert.equal(typeof other.body.idle_s, "number");
});

test("a deliberate override takes the lane and raises the generation", async () => {
  const before = (await queue()).body.generation;
  const taken = await hold("s-three", "&override=1");
  assert.equal(taken.status, 200);
  assert.equal(taken.body.generation, before + 1);
  // and the previous holder is refused everywhere it mattered
  const stale = await post(`/select?owner=${LANE}&session=s-one&box=m3&op=${op()}&row=abc123abc123`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "generation changed");
  assert.equal(stale.body.generation, taken.body.generation);
  const staleReply = await post(`/reply?owner=${LANE}&session=s-one&box=m3&op=${op()}&ctx=x`, "no");
  assert.equal(staleReply.status, 409);
  assert.equal(staleReply.body.error, "generation changed");
});

test("a lane whose holder has gone quiet can be taken, and the generation rises", async () => {
  const before = (await api(`/queue?owner=${LANE}&session=s-three`)).body.generation;
  await sleep((HOLDER_IDLE_S + 1) * 1000);
  const taken = await hold("s-one");
  assert.equal(taken.status, 200);
  assert.equal(taken.body.generation, before + 1);
});

// ---- the two replay classes -------------------------------------------------

test("a reply that names an id lands once and answers the same result", async () => {
  const chosen = await select("m3");
  assert.equal(chosen.status, 200);
  const opened = await post(`/open?owner=${LANE}&session=s-one&box=m3&op=${op()}`);
  assert.equal((await post(`/opened?owner=${LANE}&session=s-one&delivery=${opened.body.delivery}&op=${op()}&route=tool`)).status, 200);
  const operation = op();
  const route = `/reply?owner=${LANE}&session=s-one&box=m3&op=${operation}&ctx=sorting+the+packets`;
  const first = await post(route, "Sorted them by sowing month.");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const before = await card("m3");
  const again = await post(route, "Sorted them by sowing month.");
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  const after = await card("m3");
  assert.equal(after.replies, before.replies, "the retry wrote the reply twice");
  assert.equal(after.replyFull, "Sorted them by sowing month.");
});

test("the same id carrying other words is refused and nothing is stored", async () => {
  const chosen = await select("m2");
  assert.equal(chosen.status, 200);
  const operation = op();
  assert.equal((await post(`/note?owner=${LANE}&session=s-one&box=m2&op=${operation}`, "Sanded the first coat.")).status, 200);
  const other = await post(`/note?owner=${LANE}&session=s-one&box=m2&op=${operation}`, "Something else entirely.");
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "operation id reused with a different payload");
  assert.equal((await card("m2")).replyFull, "Sanded the first coat.");
});

test("a selection whose answer was lost, then a restart, is told its place is gone", async () => {
  const chosen = await select("m1");
  assert.equal(chosen.status, 200);
  const epochBefore = (await queue()).body.epoch;
  await stopServer();
  await startServer();
  const listed = (await queue()).body;
  assert.equal(listed.epoch, epochBefore + 1, "the epoch did not rise at the start");
  assert.equal(listed.held, null, "a restart resumed a reservation");
  // the retry carries its own id and its own row, so this is a genuine replay
  // and not a second, different request
  const replay = await post(`/select?owner=${LANE}&session=s-one&box=m1&op=${chosen.operation}&row=${chosen.row}`);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, "reservation gone");
  assert.equal(replay.body.row.box, "m1", "the conflict did not carry the card's current row");
  // the honest recovery is a fresh id under the fresh row, which works
  const fresh = await select("m1");
  assert.equal(fresh.status, 200);
  assert.equal((await post(`/release?owner=${LANE}&session=s-one&box=m1&op=${op()}`)).status, 200);
});

// ---- mode behaviour ---------------------------------------------------------

test("a select lane names the route to use instead of the legacy ones", async () => {
  const ack = await post(`/ack?owner=${LANE}&token=whatever`);
  assert.equal(ack.status, 409);
  assert.deepEqual(ack.body, { error: "use opened" });
  const fresh = await api(`/fresh?owner=${LANE}`);
  assert.equal(fresh.status, 409);
  assert.deepEqual(fresh.body, { error: "use open with fresh=1" });
});

test("an auto lane is served exactly as it always was", async () => {
  assert.equal((await post(`/send?box=p1`, "the other lane needs a look")).status, 200);
  const claimed = await api(`/wait?owner=${AUTO_LANE}&timeout=5`);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.box, "p1");
  assert.deepEqual(claimed.body.messages, ["the other lane needs a look"]);
  assert.equal(typeof claimed.body.ack, "string");
  assert.equal((await post(`/ack?owner=${AUTO_LANE}&token=${claimed.body.ack}`)).status, 200);
  const fresh = await api(`/fresh?owner=${AUTO_LANE}`);
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.messages, []);
  assert.equal((await post(`/reply?box=p1&ctx=looked`, "Looked, nothing to do.")).status, 200);
});

test("a select lane's wait blocks and names the queue rather than handing a card over", async () => {
  const told = await api(`/wait?owner=${LANE}&timeout=5`);
  assert.equal(told.status, 200);
  assert.equal(told.body.select, true);
  assert.equal(told.body.use, "GET /queue");
  assert.equal(told.body.box, undefined, "a select lane was handed a card by the legacy wait");
  assert.equal((await queue()).body.held, null, "the legacy wait claimed on a select lane");
});

test("flipping a lane back to auto changes selection only", async () => {
  assert.equal((await post(`/mode?owner=${LANE}&mode=auto`)).status, 200);
  const claimed = await api(`/wait?owner=${LANE}&timeout=5`);
  assert.equal(claimed.status, 200);
  assert.equal(typeof claimed.body.box, "string", "the old loop did not work after a rollback");
  assert.equal((await post(`/ack?owner=${LANE}&token=${claimed.body.ack}`)).status, 200);
  assert.equal((await post(`/mode?owner=${LANE}&mode=select`)).status, 200);
  assert.equal((await hold()).status, 200);
});
