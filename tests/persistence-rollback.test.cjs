// The commit boundary under a disk that fails, on every side of it. A failed
// save puts the board's memory back to its file; this is about everything
// that must go back with it or wait for it: the runtime owner registries a
// new lane touches, the transcript rows and log lines every mutation writes,
// the push a turn sends, and the readers and listeners that must not be
// blacked out by a disk the commands are already refusing. Fault injection is
// by folder permissions only. One fixture server on a free port with its
// logs outside the folder that fails; the suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ACK_GRACE_S = 1.0;   // ACK_GRACE in this fixture

let outer;
let app;
let logs;
let binDir;
let port;
let origin;
let bridgeOrigin;
let bridgeCookie;
let child;

function patch(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `fixture patch did not apply: ${from}`);
  return out;
}

async function startServer() {
  // the interpreter is resolved here, on this process's PATH, because the child
  // is given a PATH with no tailscale on it (so a push that is attempted is
  // written down as skipped for that reason, which is how the attempt is
  // observed), and a bare name would be looked up on that empty PATH
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  child = spawn(python, [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, PATH: binDir, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs,
           FACILITATOR_LOG_LEVEL: "debug" },
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
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, body };
}

// a phone's subscription is kept with the sign-in it was made under, and a push
// is only sent to one that still has it, so it goes in through the phone's port
async function post(route, body) {
  if (route.startsWith("/push/subscribe")) {
    const response = await fetch(bridgeOrigin + route, {
      method: "POST", body,
      headers: { Origin: bridgeOrigin, Cookie: bridgeCookie },
    });
    return { status: response.status, body: await response.json() };
  }
  return api(route, { method: "POST", body });
}

async function state() {
  return (await api("/state")).body;
}

async function events() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

async function transcript() {
  try {
    return (await readFile(path.join(app, "transcript.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function linesUntil(kind, count, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = (await events()).filter(e => e.kind === kind);
    if (seen.length >= count) return seen;
    if (Date.now() > deadline) return seen;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-rollback-"));
  app = path.join(outer, "app");
  logs = path.join(outer, "logs");
  binDir = path.join(outer, "bin");
  await mkdir(app);
  await mkdir(binDir);
  port = await require("./fixture-auth.cjs").freePortPair();
  origin = `http://127.0.0.1:${port}`;
  bridgeOrigin = `http://127.0.0.1:${port + 1}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = patch(source, "ACK_GRACE = 90.0", `ACK_GRACE = ${ACK_GRACE_S}`);
  source = patch(source, 'TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
    'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"');
  source = patch(source,
    '        _log("title", bid, box["title"])\n        _save()',
    '        _log("title", bid, box["title"])\n' +
    '        if text == "fixture-raise-after-title-log":\n' +
    '            raise RuntimeError("synthetic mutation fault")\n' +
    '        _save()');
  source = patch(source,
    '    global _last_durable\n    _state["rev"] = int(_state.get("rev", 0)) + 1',
    '    global _last_durable\n' +
    '    fixture_countdown = HERE / ".fixture-save-countdown"\n' +
    '    if fixture_countdown.is_file():\n' +
    '        remaining = int(fixture_countdown.read_text())\n' +
    '        if remaining <= 0:\n' +
    '            fixture_countdown.unlink()\n' +
    '            _restore_last_durable()\n' +
    '            raise SaveFailed("injected")\n' +
    '        fixture_countdown.write_text(str(remaining - 1))\n' +
    '    _state["rev"] = int(_state.get("rev", 0)) + 1');
  source = patch(source,
    '        try:\n            threading.Thread(target=_push_turn, args=(bid,), daemon=True).start()',
    '        try:\n' +
    '            if (HERE / ".fixture-push-start-fails").is_file():\n' +
    '                raise RuntimeError("cannot start new thread")\n' +
    '            threading.Thread(target=_push_turn, args=(bid,), daemon=True).start()');
  await writeFile(path.join(app, "server.py"), source);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(app, "server.py")));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "rollback fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      // not an m-number: a lane the first case makes gets its first card from
      // the board's own counter, and that card is m1
      { id: "5", bucket: "meta", title: "Answered once", owner: "facilitator", context: "an earlier reply" },
    ],
  }));
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  execFileSync(python, ["-c", "import bridge_auth; bridge_auth.set_password('FixtureRollback7!')"], { cwd: app });
  await startServer();
  const login = await fetch(bridgeOrigin + "/auth/login", {
    method: "POST", headers: { Origin: bridgeOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "FixtureRollback7!" }),
  });
  assert.equal(login.status, 200);
  bridgeCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(bridgeCookie, "fixture login did not issue a bridge session");
});

after(async () => {
  await chmod(app, 0o700).catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a failed project save leaves the owner registries as they were: reads and waits keep answering, and the retry makes the lane under its own name", async () => {
  // the lane has listened once, so a wait under the failing disk needs no
  // save of its own and can only be refused by the defect this test is for
  assert.deepEqual((await api("/wait?owner=facilitator&timeout=0.2")).body, { idle: true });
  const lanesBefore = Object.keys((await state()).listening);
  await chmod(app, 0o500);
  let made, read, phone, wait;
  try {
    made = await post("/project?name=probe-lane", homedir());
    read = await api("/state");
    phone = await api("/m/state");
    wait = await api("/wait?owner=facilitator&timeout=0.2");
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(made.status, 500, "a project whose save failed was not answered 500");
  // while the disk is failing every read and wait still answers: the lane the
  // save could not keep is not left in the registries the reads walk
  assert.equal(read.status, 200, "a board read crashed after the failed project save");
  assert.deepEqual(Object.keys(read.body.listening), lanesBefore, "the failed lane stayed in the runtime registry");
  assert.equal(phone.status, 200, "the phone's reading crashed after the failed project save");
  assert.equal(wait.status, 200, "a wait crashed after the failed project save");
  assert.deepEqual(wait.body, { idle: true });
  // after recovery, still without a restart
  assert.equal((await api("/state")).status, 200);
  assert.equal((await api("/wait?owner=facilitator&timeout=0.2")).status, 200);
  const retried = await post("/project?name=probe-lane", homedir());
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.id, "probe-lane", "the rolled-back lane's name was still taken, so the retry walked to a suffix");
  const after = await state();
  assert.ok(Object.hasOwn(after.listening, "probe-lane"), "the retried lane is not in the registries");
  assert.ok(Object.hasOwn(after.pwds, "probe-lane"));
  assert.equal((await api("/wait?owner=probe-lane&timeout=0.2")).status, 200, "the new lane cannot be waited on");
  assert.equal((await api("/m/state")).status, 200);
  const crashes = (await events()).filter(e => e.kind === "crash");
  assert.deepEqual(crashes, [], "a crash line was written: " + JSON.stringify(crashes.map(c => [c.route, c.error])));
});

test("a failed save writes no transcript row and no log line for the event: the reply, the note, and a helper that closes a card", async () => {
  const rowsBefore = (await transcript()).length;
  const infoBefore = (await events()).filter(e => ["agent", "note", "done"].includes(e.kind)).length;
  await chmod(app, 0o500);
  let reply, note, close;
  try {
    reply = await post("/reply?box=0", "a reply under a failing disk");
    note = await post("/note?box=0", "a note under a failing disk");
    close = await post("/close?box=5");
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(reply.status, 500);
  assert.equal(note.status, 500);
  assert.equal(close.status, 500);
  const box0 = (await state()).boxes.find(b => b.id === "0");
  assert.equal(box0.replies, 0, "the failed reply changed the card");
  assert.equal((await state()).boxes.find(b => b.id === "5").done, false, "the failed close marked the card done");
  const rows = await transcript();
  assert.equal(rows.length, rowsBefore, "a failed save wrote transcript rows: " + JSON.stringify(rows.slice(rowsBefore).map(r => r.kind)));
  const thread = await api("/thread?box=0&n=20");
  assert.deepEqual(thread.body.messages.filter(m => m.kind !== "user"), [], "history shows a reply the board rolled back");
  assert.equal((await events()).filter(e => ["agent", "note", "done"].includes(e.kind)).length, infoBefore,
    "the log says an event happened that the board rolled back");
  // once the disk is back each lands with exactly one row and one line
  assert.equal((await post("/reply?box=0", "a reply once the disk is back")).status, 200);
  assert.equal((await post("/close?box=5")).status, 200);
  const landed = await transcript();
  assert.deepEqual(landed.slice(rowsBefore).map(r => [r.kind, r.box]), [["agent", "0"], ["done", "5"]]);
  assert.deepEqual((await api("/thread?box=0&n=20")).body.messages.filter(m => m.kind === "agent").map(m => m.text),
    ["a reply once the disk is back"]);
  assert.equal((await events()).filter(e => e.kind === "agent").length, infoBefore + 1);
  assert.equal((await post("/done?box=5&v=0")).status, 200);
});

test("a push for a turn that did not commit is never sent, and one for a turn that did is", async () => {
  assert.equal((await post("/push/subscribe", JSON.stringify({ endpoint: "https://push.example.test/one", keys: { p256dh: "a", auth: "b" } }))).status, 200);
  const skipsBefore = (await events()).filter(e => e.kind === "pushskip").length;
  await chmod(app, 0o500);
  let reply;
  try {
    reply = await post("/reply?box=0", "a turn under a failing disk");
    await new Promise(resolve => setTimeout(resolve, 400));
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(reply.status, 500);
  assert.equal((await events()).filter(e => e.kind === "pushskip").length, skipsBefore,
    "a push was attempted for a reply the board rolled back");
  assert.equal((await post("/reply?box=0", "a turn once the disk is back")).status, 200);
  const skips = await linesUntil("pushskip", skipsBefore + 1);
  assert.equal(skips.length, skipsBefore + 1, "the push for a committed turn was not attempted");
  assert.equal(skips.at(-1).box, "0");
  assert.equal(skips.at(-1).reason, "tailscale unavailable");
});

test("a reader survives a failing disk: a clock whose save fails answers the restored board, and lands once the disk is back", async () => {
  assert.equal((await post("/send?box=0", "claimed and never confirmed")).status, 200);
  const claim = await api("/wait?owner=facilitator&timeout=2&agent=probe");
  assert.equal(claim.body.box, "0");
  const rowsBefore = (await transcript()).length;
  await chmod(app, 0o500);
  let reads, phoneReads;
  try {
    await new Promise(resolve => setTimeout(resolve, (ACK_GRACE_S + 0.3) * 1000));   // past the ack grace: the sweep wants to bounce the claim
    reads = [await api("/state"), await api("/state")];
    phoneReads = [await api("/m/state"), await api("/m/state")];
  } finally {
    await chmod(app, 0o700);
  }
  for (const read of [...reads, ...phoneReads]) assert.equal(read.status, 200, "a reading was refused because the sweep's save failed");
  // the bounce could not be saved, so the restored board still shows the claim held
  assert.equal(reads.at(-1).body.busy.facilitator, "0", "the restored board lost the claim the disk could not release");
  assert.ok((await events()).filter(e => e.kind === "savefail").length >= 1, "the failed sweep wrote no savefail line");
  assert.equal((await transcript()).length, rowsBefore, "the failed bounce wrote its transcript row anyway");
  // once the disk is back the very next reading lands the bounce, once
  const landed = await api("/state");
  assert.equal(landed.status, 200);
  assert.equal(landed.body.busy.facilitator, null, "the bounce did not land once the disk was back");
  assert.equal(landed.body.boxes.find(b => b.id === "0").queuePos, 1);
  const rows = await transcript();
  assert.deepEqual(rows.slice(rowsBefore).map(r => r.kind), ["unacked"]);
  assert.equal((await post(`/ack?owner=facilitator&token=${claim.body.ack}`)).status, 409, "the bounced claim's token was still good");
});

test("a claim whose save fails answers the wait with the plain 500, not a crash line, and the card is not held", async () => {
  const crashesBefore = (await events()).filter(e => e.kind === "crash").length;
  await chmod(app, 0o500);
  let wait;
  try {
    wait = await api("/wait?owner=facilitator&timeout=1&agent=probe");
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(wait.status, 500, JSON.stringify(wait.body));
  assert.deepEqual(wait.body, { error: "the board could not save its state" });
  assert.equal((await state()).busy.facilitator, null, "a claim the disk could not keep is still held");
  assert.equal((await events()).filter(e => e.kind === "crash").length, crashesBefore, "the failed claim wrote a crash line");
  const claim = await api("/wait?owner=facilitator&timeout=2&agent=probe");
  assert.equal(claim.body.box, "0", "the card was not handed out once the disk was back");
  assert.equal((await post(`/ack?owner=facilitator&token=${claim.body.ack}`)).status, 200);
  assert.equal((await post("/reply?box=0", "answered after the failing claim")).status, 200);
});

test("a folder that cannot be flushed after the rename keeps the commit, replays, and says so in its own line", async () => {
  const syncBefore = (await events()).filter(e => e.kind === "syncfail").length;
  const saveBefore = (await events()).filter(e => e.kind === "savefail").length;
  await chmod(app, 0o311);   // the folder can be written and searched but not opened for a flush
  let sent, retry, disk;
  try {
    sent = await post("/send?box=0&op=send-unsyncable-01", "words under an unflushable folder");
    retry = await post("/send?box=0&op=send-unsyncable-01", "words under an unflushable folder");
    disk = JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(sent.status, 200, "a save whose folder flush failed was refused, though the file was installed");
  assert.equal(retry.body.replayed, true);
  assert.ok(disk.ops["send-unsyncable-01"], "the installed file lacks the receipt");
  assert.deepEqual(disk.boxes.find(b => b.id === "0").pending.map(m => m.text), ["words under an unflushable folder"]);
  const sync = (await events()).filter(e => e.kind === "syncfail");
  assert.equal(sync.length, syncBefore + 1, "the folder flush that failed was passed over silently");
  assert.equal(sync.at(-1).level, "error");
  assert.equal(sync.at(-1).step, "folder");
  assert.ok(sync.at(-1).reason);
  assert.equal((await events()).filter(e => e.kind === "savefail").length, saveBefore, "a committed save was written down as failed");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("an unexpected exception before save restores the board and drops its queued event before another request", async () => {
  const before = await state();
  const boxBefore = before.boxes.find(b => b.id === "0");
  const rowsBefore = (await transcript()).length;
  const titleLinesBefore = (await events()).filter(e => e.kind === "title").length;
  const crashesBefore = (await events()).filter(e => e.kind === "crash").length;

  const failed = await post("/title?box=0", "fixture-raise-after-title-log");
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "the board hit an error answering this request" });

  const restored = await state();
  assert.equal(restored.rev, before.rev, "the failed request consumed a revision");
  assert.equal(restored.boxes.find(b => b.id === "0").title, boxBefore.title,
    "the title mutation escaped the failed request");
  assert.equal((await transcript()).length, rowsBefore, "the failed request wrote a transcript row");
  assert.equal((await events()).filter(e => e.kind === "title").length, titleLinesBefore,
    "the failed request wrote its event line");
  const crashes = (await events()).filter(e => e.kind === "crash");
  assert.equal(crashes.length, crashesBefore + 1);
  assert.equal(crashes.at(-1).route, "/title");

  const sent = await post("/send?box=0&op=after-failed-title-01", "the next ordinary send");
  assert.equal(sent.status, 200);
  const after = await state();
  assert.equal(after.rev, before.rev + 1);
  assert.equal(after.boxes.find(b => b.id === "0").title, boxBefore.title,
    "the next save committed the abandoned title");
  const added = (await transcript()).slice(rowsBefore);
  assert.deepEqual(added.map(row => [row.kind, row.text]), [["user", "the next ordinary send"]],
    "the next save flushed an event from the failed request");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("working flag-down and its sweep share one save and one event commit", async () => {
  assert.equal((await post("/working?box=0&v=1")).status, 200);
  const before = await state();
  const rowsBefore = (await transcript()).length;
  const countdown = path.join(app, ".fixture-save-countdown");
  await writeFile(countdown, "1");
  let stopped;
  try {
    stopped = await post("/working?box=0&v=0");
  } finally {
    await rm(countdown, { force: true });
  }
  assert.equal(stopped.status, 200,
    "flag-down reached a second save after its state had already committed");
  const after = await state();
  assert.equal(after.rev, before.rev + 1, "one working request committed more than one revision");
  const box = after.boxes.find(b => b.id === "0");
  assert.equal(box.bg, false);
  assert.notEqual(box.state, "working");
  assert.deepEqual((await transcript()).slice(rowsBefore).map(row => row.kind), ["workdone"],
    "the state and its workdone event did not commit together");
});

test("a push thread that cannot start after the rename does not turn the committed reply into a 500", async () => {
  assert.equal((await post("/push/subscribe", JSON.stringify({
    endpoint: "https://push.example.test/postcommit", keys: { p256dh: "a", auth: "b" },
  }))).status, 200);
  const before = await state();
  const repliesBefore = before.boxes.find(b => b.id === "5").replies;
  const rowsBefore = (await transcript()).length;
  const failuresBefore = (await events()).filter(e => e.kind === "pushfail").length;
  const sentinel = path.join(app, ".fixture-push-start-fails");
  await writeFile(sentinel, "fail");
  let reply;
  try {
    reply = await post("/reply?box=5", "a reply whose push thread cannot start");
  } finally {
    await rm(sentinel, { force: true });
  }
  assert.equal(reply.status, 200,
    "a post-rename push scheduling failure made an installed reply look refused");
  const after = await state();
  assert.equal(after.rev, before.rev + 1);
  assert.equal(after.boxes.find(b => b.id === "5").replies, repliesBefore + 1);
  assert.deepEqual((await transcript()).slice(rowsBefore).map(row => [row.kind, row.text]),
    [["agent", "a reply whose push thread cannot start"]]);
  const failures = (await events()).filter(e => e.kind === "pushfail");
  assert.equal(failures.length, failuresBefore + 1);
  assert.equal(failures.at(-1).box, "5");
  assert.equal(failures.at(-1).reason, "RuntimeError");
});
