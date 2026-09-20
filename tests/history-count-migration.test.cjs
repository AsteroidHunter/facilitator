// The board's count of final replies, for cards it was answering long before
// it kept that count.
//
// A card's history arrows are drawn from olderReplies, which the board sends
// with the card. Cards answered before the board counted them have to be
// counted once from the transcript, and that count has to agree with the list
// the stepper itself walks: every final reply the transcript holds, minus the
// one the card is showing, and progress notes are not pages of it.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let fixtureDir;
let origin;
let port;
let serverOutput = "";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const picked = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return picked;
}

async function get(route) {
  const response = await fetch(origin + route);
  return { status: response.status, body: await response.json() };
}

async function post(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function startServer() {
  serverOutput = "";
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { serverOutput += chunk; });
  child.stderr.on("data", chunk => { serverOutput += chunk; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${serverOutput}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not start:\n${serverOutput}`);
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

function statePath() {
  return path.join(fixtureDir, "state.json");
}

function transcriptPath() {
  return path.join(fixtureDir, "transcript.jsonl");
}

async function readState() {
  return JSON.parse(await readFile(statePath(), "utf8"));
}

async function readTranscript() {
  return (await readFile(transcriptPath(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

async function boardBox(id) {
  const state = await get("/state");
  const found = state.body.boxes.find(box => box.id === id);
  assert.ok(found, `the board has no card ${id}`);
  return found;
}

// what the card's own history stepper walks: the list the board hands out
async function walkable(id) {
  const answer = await get(`/history?box=${id}`);
  assert.equal(answer.status, 200, `the board refused the history of ${id}`);
  return answer.body.replies;
}

// and the same thing worked out independently from the raw transcript, the
// way a reader with the whole file in front of them would work it out: every
// final reply of that card, without the one the card is showing, which the
// card's own saved reply_kind says outright. Only sound where the whole
// conversation fits in one thread window
async function walkableFromTranscript(id) {
  const thread = await get(`/thread?box=${id}&n=1000`);
  const saved = await readState();
  const card = saved.boxes.find(box => box.id === id);
  const replies = thread.body.messages.filter(m => m.kind === "agent").map(m => m.replyFull ?? m.text);
  if (card.reply_kind === "agent" && replies.length) replies.pop();
  return replies;
}

// older is the number of pages expected, or the exact pages themselves
async function agreed(id, older, what) {
  const count = Array.isArray(older) ? older.length : older;
  const card = await boardBox(id);
  const list = await walkable(id);
  assert.equal(card.olderReplies, count, `${what}: the board's count of older replies`);
  assert.equal(list.length, card.olderReplies,
    `${what}: the count sent with the card and the list the stepper walks disagree`);
  if (Array.isArray(older)) assert.deepEqual(list, older, `${what}: the pages the arrows step back to`);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-history-counts-"));
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["index.html", "manifest.json", "sw.js", "card-markdown.js", "card-tokens.css", "card-logic.js",
                      "card-report.js", "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "history counts",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "" },
    ],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("a board answered before the count existed is counted once, from its transcript", async () => {
  // Four cards built through the board's own routes, so state.json and the
  // transcript hold exactly what a working board would have left behind.
  const twice = (await post("/create?owner=facilitator", "Answered twice")).body.id;
  await post(`/send?box=${twice}`, "First owner message.");
  await post(`/reply?box=${twice}`, "First answer.");
  await post(`/send?box=${twice}`, "Second owner message.");
  await post(`/reply?box=${twice}`, "Second answer.");

  const noteOnTop = (await post("/create?owner=facilitator", "A note over one answer")).body.id;
  await post(`/send?box=${noteOnTop}`, "The question.");
  await post(`/reply?box=${noteOnTop}`, "The one answer.");
  await post(`/send?box=${noteOnTop}`, "A follow-up.");
  await post(`/note?box=${noteOnTop}`, "Started on the follow-up.");

  const notesUnder = (await post("/create?owner=facilitator", "Notes under one answer")).body.id;
  await post(`/send?box=${notesUnder}`, "The question.");
  await post(`/note?box=${notesUnder}`, "Reading it.");
  await post(`/note?box=${notesUnder}`, "Still reading it.");
  await post(`/reply?box=${notesUnder}`, "The one answer.");

  const untouched = (await post("/create?owner=facilitator", "Never answered")).body.id;
  await post(`/send?box=${untouched}`, "A question nobody has answered.");

  // and two cards standing in for what an older board left: one whose replies
  // were written before the transcript's schema marker, in the retired
  // compact---full shape, and one whose single reply was written twice under
  // one operation id by a retry after a crash
  await stopServer();
  const before = await readState();
  const legacy = { ...before.boxes.find(box => box.id === untouched), id: "m90",
                   title: "Answered by an older board", reply: "", reply_full: "", reply_short: "",
                   pending: [], replies: 2 };
  const retried = { ...legacy, id: "m91", title: "Its reply row written twice", replies: 1 };
  legacy.reply = legacy.reply_full = legacy.reply_short = "Older full two";
  retried.reply = retried.reply_full = retried.reply_short = "The retried answer";
  before.boxes.push(legacy, retried);
  const rows = await readTranscript();
  const markerAt = rows.findIndex(row => row.kind === "schema");
  assert.ok(markerAt >= 0, "the fixture transcript has no schema marker to stand before");
  rows.splice(markerAt, 0,
    { ts: 100, kind: "user", box: "m90", text: "An old question." },
    { ts: 101, kind: "agent", box: "m90", text: "Older compact one\n---\nOlder full one" },
    { ts: 102, kind: "agent", box: "m90", text: "Older compact two\n---\nOlder full two" });
  rows.push(
    { ts: 200, kind: "agent", box: "m91", text: "The retried answer",
      reply_full: "The retried answer", reply_short: "The retried answer", op: "retry-op-1234" },
    { ts: 200, kind: "agent", box: "m91", text: "The retried answer",
      reply_full: "The retried answer", reply_short: "The retried answer", op: "retry-op-1234" });
  await writeFile(transcriptPath(), rows.map(row => JSON.stringify(row)).join("\n") + "\n");

  // the state an older board saved: every card, and the board itself, with no
  // trace of the count this one keeps
  for (const box of before.boxes) {
    delete box.full_replies;
    delete box.reply_kind;
  }
  delete before.history_counts_version;
  await writeFile(statePath(), JSON.stringify(before, null, 1));
  // what the counting must not touch: the discussion itself
  const transcriptBefore = await readFile(transcriptPath(), "utf8");
  const conversationsBefore = before.boxes.map(box =>
    [box.id, box.title, box.reply_full, box.reply_short, box.replies, box.pending.length]);
  await startServer();

  await agreed(twice, ["First answer."], "a card answered twice");
  await agreed(noteOnTop, ["The one answer."], "a progress note over the one answer");
  await agreed(notesUnder, [], "progress notes under the one answer");
  await agreed(untouched, [], "a card nobody has answered");
  await agreed("m90", ["Older full one"], "a card answered before the transcript's schema marker");
  await agreed("m91", [], "a reply row written twice under one operation id");
  // and the same lists, worked out from the raw transcript rather than asked for
  for (const id of [twice, noteOnTop, notesUnder, untouched, "m90", "m91"]) {
    assert.deepEqual(await walkable(id), await walkableFromTranscript(id),
      `the history the board hands out for ${id} is not what its transcript holds`);
  }

  const saved = await readState();
  assert.equal(saved.history_counts_version, 1);
  assert.equal(await readFile(transcriptPath(), "utf8"), transcriptBefore,
    "counting the replies wrote something into the transcript");
  assert.deepEqual(saved.boxes.map(box =>
    [box.id, box.title, box.reply_full, box.reply_short, box.replies, box.pending.length]),
  conversationsBefore, "counting the replies changed what the cards say");
  const counts = Object.fromEntries(saved.boxes.map(box => [box.id, [box.full_replies, box.reply_kind]]));
  assert.deepEqual(counts[twice], [2, "agent"]);
  assert.deepEqual(counts[noteOnTop], [1, "note"]);
  assert.deepEqual(counts[notesUnder], [1, "agent"]);
  assert.deepEqual(counts[untouched], [0, ""]);
  assert.deepEqual(counts.m90, [2, "agent"], "the retired compact---full rows were not read as replies");
  assert.deepEqual(counts.m91, [1, "agent"], "one event written twice was counted twice");

  // a restart counts nothing again and moves nothing
  await stopServer();
  await startServer();
  const again = await readState();
  assert.deepEqual(Object.fromEntries(again.boxes.map(box => [box.id, [box.full_replies, box.reply_kind]])),
    counts, "a second start recounted a board that was already counted");
  await agreed(twice, ["First answer."], "a card answered twice, after a restart");
  await agreed("m90", ["Older full one"], "an older board's card, after a restart");
});

// The two shapes a page could not read for itself: a card whose answer is
// buried under more rows than a thread window holds, and a progress note that
// repeats the answer under it word for word. Both are decided on the board,
// before the cap and by the card's own record, so the count sent with the card
// and the list the arrows walk say the same thing at both.
test("a long note run and a repeated answer are counted the way they are walked", async () => {
  const buried = (await post("/create?owner=facilitator", "An answer under a long run")).body.id;
  await post(`/send?box=${buried}`, "The question this answers.");
  await post(`/reply?box=${buried}`, "The answer under the long run.");
  await post(`/send?box=${buried}`, "One more thing.");
  for (let i = 0; i < 201; i++) await post(`/note?box=${buried}`, `Progress note number ${i + 1}.`);

  const repeated = (await post("/create?owner=facilitator", "A note repeating its answer")).body.id;
  const words = "The same words, in the answer and in the note.";
  await post(`/send?box=${repeated}`, "The question.");
  await post(`/reply?box=${repeated}`, words);
  await post(`/send?box=${repeated}`, "A follow-up.");
  await post(`/note?box=${repeated}`, words);

  // the shape itself: a window of this card's last 200 rows holds no answer
  const window200 = await get(`/thread?box=${buried}&n=200`);
  assert.equal(window200.body.messages.filter(m => m.kind === "agent").length, 0,
    "the fixture did not push the answer out of the plain thread window");
  assert.equal(window200.body.messages.length, 200);

  await agreed(buried, ["The answer under the long run."], "an answer under a long run of notes");
  await agreed(repeated, [words], "a note repeating the answer under it");
  assert.deepEqual(await walkable(buried), await walkableFromTranscript(buried),
    "the buried answer the board hands out is not the one its transcript holds");
  assert.deepEqual(await walkable(repeated), await walkableFromTranscript(repeated),
    "the repeated answer the board hands out is not the one its transcript holds");

  // and both shapes again through a board counted from the transcript alone
  await stopServer();
  const saved = await readState();
  for (const box of saved.boxes) {
    delete box.full_replies;
    delete box.reply_kind;
  }
  delete saved.history_counts_version;
  await writeFile(statePath(), JSON.stringify(saved, null, 1));
  await startServer();
  await agreed(buried, ["The answer under the long run."], "a long run of notes, counted at startup");
  await agreed(repeated, [words], "a repeated answer, counted at startup");
  const counted = (await readState()).boxes;
  assert.deepEqual(counted.find(box => box.id === buried).reply_kind, "note");
  assert.deepEqual(counted.find(box => box.id === repeated).reply_kind, "note",
    "a note repeating its answer was counted as the answer itself");
});

// the cap is one number on both sides, so the board never counts a page the
// history route will not hand out
test("the count and the list stop at the same cap", async () => {
  const deep = (await post("/create?owner=facilitator", "Answered more times than the cap")).body.id;
  for (let i = 0; i < 202; i++) await post(`/reply?box=${deep}`, `Answer number ${i + 1}.`);
  const card = await boardBox(deep);
  const list = await walkable(deep);
  assert.equal(card.olderReplies, 200, "the count did not stop where the history route stops");
  assert.equal(list.length, 200, "the history route handed out a different number of pages");
  assert.equal(list[list.length - 1], "Answer number 201.",
    "the newest page behind the card is not the answer before the live one");
  assert.equal(list[0], "Answer number 2.", "the cap did not keep the newest pages");
  assert.equal((await readState()).boxes.find(box => box.id === deep).full_replies, 202,
    "the card stopped counting its own replies at the cap");

  const missing = await get("/history?box=nosuchcard");
  assert.equal(missing.status, 400, "the history of a card that does not exist was answered");
});

test("the board keeps the count itself from there on", async () => {
  const card = (await post("/create?owner=facilitator", "Kept from here on")).body.id;
  await agreed(card, 0, "a card just made");

  await post(`/send?box=${card}`, "The first question.");
  await post(`/reply?box=${card}`, "The first answer.");
  await agreed(card, 0, "one answer and nothing behind it");

  await post(`/note?box=${card}`, "Working on the next one.");
  await agreed(card, 1, "a progress note over the first answer");
  assert.equal((await boardBox(card)).replies, 2, "the aggregate count stopped counting notes");

  await post(`/send?box=${card}`, "The second question.");
  await post(`/reply?box=${card}`, "The second answer.");
  await agreed(card, 1, "two answers");

  await post(`/reply?box=${card}`, "The third answer.");
  await agreed(card, 2, "three answers");

  // and the count survives the board being stopped and started again
  await stopServer();
  await startServer();
  await agreed(card, 2, "three answers, after a restart");
});
