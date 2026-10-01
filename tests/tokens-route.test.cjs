// the home page's token counts, from the logs to the route, with no browser.
// each board below is a temporary copy of the server on free ports, given a
// temporary home folder holding small invented Claude Code and Codex logs, and
// GET /tokens/daily is read back against the rule tokens.py writes down:
//
//   rule       a day's total is fresh input + cache write + cache read + output,
//              Codex's cached input taken out of its input, the split kept
//   once       a message or response counts once however many lines and files
//              repeat it, a message at the largest usage any line carries; an
//              older Codex file is read from its token_count events, once per
//              running total, so a forked thread replaying its parent adds nothing
//   cache      an unchanged file is never opened again, an appended one is read
//              from where it stopped, a shrunk one from the start, a deleted one
//              keeps its counts, a restarted board carries on from the cache
//              file, and that file holds no log text
//   midnight   days are the local calendar day, a half hour zone included
//   folders    run.config.json and the tools' own variables move the folders;
//              no folders at all is zeros
//
// nothing here reads a real log: HOME points into the fixture every time
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
// a calendar day counted back from today in UTC, the zone most boards below run in
const day = back => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
const ROUND = 1_700_000_000;   // a stamp in whole seconds, which every layer reads back exactly

// ---- invented log lines -----------------------------------------------------------
// the padding makes a Claude line longer than the fingerprinted head, so a
// file's second line always starts past it; a short line keeps its numbers
// inside the head, where a change to them is a rewrite
const PAD = "invented words ".repeat(40);
const claude = (id, stamp, [inp, cw, cr, out], text = PAD) => JSON.stringify({
  type: "assistant", timestamp: stamp,
  message: { id, role: "assistant", content: [{ type: "text", text }],
             usage: { input_tokens: inp, cache_creation_input_tokens: cw,
                      cache_read_input_tokens: cr, output_tokens: out } },
});
const record = (id, stamp, inp, cached, out) => JSON.stringify({
  timestamp: stamp, type: "token_usage_record",
  payload: { response_id: id, usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out,
                                       reasoning_output_tokens: 0, total_tokens: inp + out } },
});
const usage = ([inp, cached, out]) => ({ input_tokens: inp, cached_input_tokens: cached,
                                         output_tokens: out, total_tokens: inp + out });
const meter = (stamp, last, total) => JSON.stringify({
  timestamp: stamp, type: "event_msg",
  payload: { type: "token_count",
             info: last ? { last_token_usage: usage(last), total_token_usage: usage(total) } : null },
});
const meta = id => JSON.stringify({ timestamp: day(5) + "T00:00:00Z", type: "session_meta",
                                    payload: { id, cwd: "/invented" } });
function put(file, lines, end = "\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + end);
}
const append = (file, text) => fs.appendFileSync(file, text);
// the same bytes with one number swapped for another of the same width
function swap(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  assert.equal(from.length, to.length);
  assert.ok(text.includes(from), `${from} is not in the file`);
  fs.writeFileSync(file, text.replace(from, to));
}
const stamp = (file, seconds) => fs.utimesSync(file, seconds, seconds);

// ---- a board of its own -----------------------------------------------------------
const boards = [];
async function board({ config } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "facilitator-tokens-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const source = fs.readFileSync(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  fs.writeFileSync(path.join(dir, "server.py"), patched);
  copyBridgeFiles(dir);
  for (const name of ["tokens.py", "m-manifest.json", "home-widgets.js", "home-widgets.css"])
    fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [{ id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" }],
  }));
  if (config) fs.writeFileSync(path.join(dir, "run.config.json"), JSON.stringify(config));
  const origin = `http://127.0.0.1:${await freePortPair()}`;
  const b = {
    dir, home, origin, child: null,
    cache: path.join(dir, "tokens-cache.json"),
    async start(extra = {}) {
      const env = { ...process.env, HOME: home, TZ: "UTC", FACILITATOR_TEST_PORT: new URL(origin).port,
                    FACILITATOR_LOG_DIR: path.join(dir, "logs"), ...extra };
      for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) if (!(name in extra)) delete env[name];
      b.child = spawn(PYTHON, [path.join(dir, "server.py")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      b.child.stdout.setEncoding("utf8");
      b.child.stderr.setEncoding("utf8");
      b.child.stdout.on("data", chunk => { output += chunk; });
      b.child.stderr.on("data", chunk => { output += chunk; });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (b.child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
        try { if ((await fetch(origin + "/state")).ok) return b; } catch {}
        await wait();
      }
      throw new Error(`fixture server did not start:\n${output}`);
    },
    async stop() {
      if (!b.child || b.child.exitCode !== null) return;
      b.child.kill("SIGTERM");
      await new Promise(resolve => b.child.once("exit", resolve));
    },
    async get(route) {
      const response = await fetch(origin + route);
      return { status: response.status, body: await response.json() };
    },
    async days(n) {
      const { status, body } = await b.get("/tokens/daily?days=" + n);
      assert.equal(status, 200);
      return body;
    },
    async total(n = 3) { return (await b.days(n)).total; },
  };
  boards.push(b);
  return b;
}
const byDay = answer => Object.fromEntries(answer.days.map(d => [d.date, d]));

after(async () => {
  for (const b of boards) {
    await b.stop();
    await rm(b.dir, { recursive: true, force: true });
  }
});

// ---- the rule ------------------------------------------------------------------------
test("each day is the four kinds added up, every message and response counted once", async () => {
  const b = await board();
  const [d0, d1, d2] = [day(0), day(1), day(2)];
  const projects = path.join(b.home, ".claude", "projects", "proj-a");
  put(path.join(projects, "s1.jsonl"), [
    claude("msg_one", d1 + "T10:00:00Z", [10, 100, 1000, 5]),
    claude("msg_one", d1 + "T10:00:01Z", [10, 100, 1000, 5]),   // the same message, streamed
    JSON.stringify({ type: "user", timestamp: d1 + "T10:00:02Z", message: { role: "user", content: "no usage" } }),
    "{not json",
    claude("msg_two", d0 + "T01:00:00Z", [1, 0, 50, 2]),
  ]);
  put(path.join(projects, "s2.jsonl"), [                          // a resumed session
    claude("msg_one", d1 + "T10:00:00Z", [10, 100, 1000, 5]),
    claude("msg_three", d0 + "T01:10:00Z", [2, 20, 200, 3]),
  ]);
  put(path.join(projects, "s1", "subagents", "agent-x.jsonl"), [claude("msg_four", d0 + "T01:20:00Z", [4, 0, 0, 4])]);
  const sessions = path.join(b.home, ".codex", "sessions", "2026", "09", "20");
  put(path.join(sessions, "rollout-a.jsonl"), [
    meta("thread-one"),
    record("resp_one", d1 + "T10:00:00Z", 1000, 900, 50),
    meter(d1 + "T10:00:05Z", [1000, 900, 50], [1000, 900, 50]),  // a meter beside records is not counted
    record("resp_two", d0 + "T01:00:00Z", 500, 0, 10),
  ]);
  put(path.join(sessions, "rollout-b.jsonl"), [                   // a spawned thread
    meta("thread-two"), meta("thread-one"),
    record("resp_two", d0 + "T01:00:00Z", 500, 0, 10),            // inherited from its parent
    record("resp_three", d0 + "T01:30:00Z", 300, 100, 30),
  ]);
  put(path.join(b.home, ".codex", "archived_sessions", "rollout-old.jsonl"), [   // an older Codex
    meta("thread-zero"),
    meter(d2 + "T09:00:00Z", [100, 40, 10], [100, 40, 10]),
    meter(d2 + "T09:01:00Z", [100, 40, 10], [100, 40, 10]),       // the same snapshot again
    meter(d2 + "T09:02:00Z", null, null),
    meter(d2 + "T09:03:00Z", [50, 0, 5], [150, 40, 15]),
  ]);
  await b.start();
  const answer = await b.days(3);
  assert.deepEqual(answer.days.map(d => d.date), [d2, d1, d0]);
  const days = byDay(answer);
  assert.deepEqual(days[d2], { date: d2, total: 165, input: 110, cache_write: 0, cache_read: 40,
                               output: 15, claude: 0, codex: 165 });
  assert.deepEqual(days[d1], { date: d1, total: 2165, input: 110, cache_write: 100, cache_read: 1900,
                               output: 55, claude: 1115, codex: 1050 });
  assert.deepEqual(days[d0], { date: d0, total: 1126, input: 707, cache_write: 20, cache_read: 350,
                               output: 49, claude: 286, codex: 840 });
  assert.equal(answer.total, 165 + 2165 + 1126);
  assert.deepEqual(answer.tools, { claude: 1115 + 286, codex: 165 + 1050 + 840 });
  assert.deepEqual(answer.kinds, { input: 927, cache_write: 120, cache_read: 2290, output: 119 });
  assert.deepEqual(answer.found, { claude: true, codex: true });

  // a year by default, oldest first and ending today, every day present
  const year = (await b.get("/tokens/daily")).body;
  assert.equal(year.days.length, 365);
  assert.equal(year.days.at(-1).date, d0);
  assert.equal(year.total, answer.total);
  for (const bad of ["0", "3661", "abc", "-1", "1.5", "99999999999999999999"]) {
    const { status, body } = await b.get("/tokens/daily?days=" + bad);
    assert.equal(status, 400, bad);
    assert.match(body.error, /days/);
  }

  // what is kept between runs is counts: no id, no thread, no word of any line
  const cache = fs.readFileSync(b.cache, "utf8");
  for (const secret of ["msg_one", "resp_two", "thread-one", "invented words", "no usage"])
    assert.ok(!cache.includes(secret), `${secret} reached the cache file`);
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /^\/tokens-cache\.json$/m);

  // and the board hands out the widgets that draw it, fetched when home opens
  for (const [name, type] of [["home-widgets.js", /^application\/javascript/], ["home-widgets.css", /^text\/css/]]) {
    const response = await fetch(b.origin + "/" + name);
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get("content-type"), type);
    assert.equal(await response.text(), fs.readFileSync(path.join(ROOT, name), "utf8"));
  }
});

// ---- the largest usage ---------------------------------------------------------------
test("a streamed reply counts at the largest usage any of its lines carries", async () => {
  const b = await board();
  const [d0, d1] = [day(0), day(1)];
  const proj = path.join(b.home, ".claude", "projects", "proj");
  const sub = path.join(proj, "s1", "subagents", "agent-a.jsonl");
  put(sub, [
    claude("msg_a", d1 + "T10:00:00Z", [10, 100, 1000, 2]),    // a subagent's early lines hold a placeholder output
    claude("msg_a", d1 + "T10:00:01Z", [10, 100, 1000, 3]),
    claude("msg_a", d1 + "T10:00:02Z", [10, 100, 1000, 60]),   // and the last one the usage of the whole reply
    claude("msg_b", d1 + "T11:00:00Z", [1, 0, 5, 40]),
    claude("msg_b", d1 + "T11:00:01Z", [1, 0, 5, 7]),          // a later line with less adds nothing
    claude("msg_c", d1 + "T23:59:59Z", [2, 0, 0, 2]),          // a reply that runs past midnight
    claude("msg_c", d0 + "T00:00:03Z", [2, 0, 0, 90]),         // stays on the day it began
    claude("msg_e", d1 + "T12:00:00Z", [10, 0, 100, 5]),       // each kind is taken at its own largest
    claude("msg_e", d1 + "T12:00:01Z", [12, 0, 100, 3]),
  ]);
  put(path.join(proj, "s1.jsonl"), [
    claude("msg_d", d0 + "T01:00:00Z", [5, 0, 50, 4]),
    claude("msg_d", d0 + "T01:00:01Z", [5, 0, 50, 4]),         // a main session repeats the usage as it is
  ]);
  await b.start();
  let days = byDay(await b.days(2));
  assert.deepEqual(days[d1], { date: d1, total: 1425, input: 25, cache_write: 100, cache_read: 1105,
                               output: 195, claude: 1425, codex: 0 });
  assert.deepEqual(days[d0], { date: d0, total: 59, input: 5, cache_write: 0, cache_read: 50,
                               output: 4, claude: 59, codex: 0 });

  // a line appended later that carries more adds the difference only, and so
  // does one appended while the board is down, which carries on from the cache
  append(sub, claude("msg_a", d1 + "T10:00:09Z", [10, 100, 1000, 80]) + "\n");
  days = byDay(await b.days(2));
  assert.equal(days[d1].output, 215);
  assert.equal(days[d1].total, 1445);
  await b.stop();
  append(sub, claude("msg_b", d1 + "T11:00:09Z", [1, 0, 5, 50]) + "\n");
  await b.start();
  days = byDay(await b.days(2));
  assert.equal(days[d1].output, 225);
  assert.equal(days[d1].total, 1455);
  assert.equal(days[d0].total, 59);

  const cache = fs.readFileSync(b.cache, "utf8");
  for (const secret of ["msg_a", "msg_b", "msg_c", "msg_d", "msg_e", "invented words"])
    assert.ok(!cache.includes(secret), `${secret} reached the cache file`);
});

test("a message that two files carry counts once, whichever file holds the most of it", async () => {
  const b = await board();
  const at = day(1) + "T10:00:00Z";
  const p = path.join(b.home, ".claude", "projects", "p");
  const [s1, s2, s3] = ["s1", "s2", "s3"].map(name => path.join(p, name + ".jsonl"));
  put(s1, [claude("msg_x", at, [10, 0, 100, 2]), claude("msg_y", at, [1, 0, 0, 1])]);   // a placeholder output
  put(s2, [claude("msg_x", at, [10, 0, 100, 50])]);                                     // a resumed copy with the final usage
  put(s3, [claude("msg_x", at, [10, 0, 100, 50]), claude("msg_z", at, [3, 0, 0, 3])]);  // and another copy of it
  for (const file of [s1, s2, s3]) stamp(file, ROUND);
  await b.start();
  // x once at 160, y 2, z 6; the first line seen would have made it 120
  assert.equal(await b.total(), 168);

  // a file read again from the start gives back what it carried: the one
  // that held the placeholder, the one that holds the final usage
  put(s1, [claude("msg_x", at, [10, 0, 100, 2], "again"), claude("msg_y", at, [1, 0, 0, 1], "again")]);
  stamp(s1, ROUND + 10);
  assert.equal(await b.total(), 168);
  put(s2, [claude("msg_x", at, [10, 0, 100, 50], "again")]);
  stamp(s2, ROUND + 10);
  assert.equal(await b.total(), 168);

  // and loses what it no longer carries
  put(s1, [claude("msg_x", at, [10, 0, 100, 2], "once more")]);
  stamp(s1, ROUND + 20);
  assert.equal(await b.total(), 166);

  // a deleted file keeps its counts, and passes them on when another file
  // carries more of the same message later, even after a restart
  fs.unlinkSync(s2);
  assert.equal(await b.total(), 166);
  await b.stop();
  append(s3, claude("msg_x", at, [10, 0, 100, 70]) + "\n");
  await b.start();
  assert.equal(await b.total(), 186);

  const cache = fs.readFileSync(b.cache, "utf8");
  for (const secret of ["msg_x", "msg_y", "msg_z", "invented words"])
    assert.ok(!cache.includes(secret), `${secret} reached the cache file`);
});

test("a message that two files carry is counted once on its first day when the zone changes", async () => {
  const b = await board();
  const d = day(3);
  const next = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
  const p = path.join(b.home, ".claude", "projects", "p");
  // 20:00 UTC is the same evening in UTC and 01:30 the next morning in Kolkata
  put(path.join(p, "s1.jsonl"), [claude("msg_x", d + "T20:00:00Z", [0, 0, 0, 2])]);
  put(path.join(p, "s2.jsonl"), [claude("msg_x", d + "T20:00:05Z", [0, 0, 0, 50])]);
  const seen = async () => {
    const days = byDay(await b.days(10));
    return { [d]: days[d].total, [next]: days[next].total };
  };
  await b.start({ TZ: "UTC" });
  assert.deepEqual(await seen(), { [d]: 50, [next]: 0 });
  await b.stop();
  await b.start({ TZ: "Asia/Kolkata" });
  assert.deepEqual(await seen(), { [d]: 0, [next]: 50 });
});

test("a forked thread in an older Codex file, replaying its parent's events, adds nothing", async () => {
  const b = await board();
  const [d2, d1] = [day(2), day(1)];
  const sessions = path.join(b.home, ".codex", "sessions", "2026", "09", "20");
  const parent = [
    meta("thread-parent"),
    meter(d2 + "T09:00:00Z", [100, 40, 10], [100, 40, 10]),
    meter(d2 + "T09:03:00Z", [50, 0, 5], [150, 40, 15]),
  ];
  put(path.join(sessions, "rollout-1-parent.jsonl"), parent);
  put(path.join(sessions, "rollout-2-child.jsonl"), [          // its own header, then its parent's
    meta("thread-child"), meta("thread-parent"),
    meter(d1 + "T12:00:00Z", [100, 40, 10], [100, 40, 10]),    // the parent's events again, stamped at the fork
    meter(d1 + "T12:00:01Z", [50, 0, 5], [150, 40, 15]),
    meter(d1 + "T12:05:00Z", [30, 0, 3], [180, 40, 18]),       // and its own work
  ]);
  // the parent moved into the archive is still one thread
  put(path.join(b.home, ".codex", "archived_sessions", "rollout-1-parent.jsonl"), parent);
  await b.start();
  const answer = await b.days(3);
  const days = byDay(answer);
  assert.deepEqual(days[d2], { date: d2, total: 165, input: 110, cache_write: 0, cache_read: 40,
                               output: 15, claude: 0, codex: 165 });
  assert.deepEqual(days[d1], { date: d1, total: 33, input: 30, cache_write: 0, cache_read: 0,
                               output: 3, claude: 0, codex: 33 });
  assert.equal(answer.total, 198);
});

// ---- the cache -----------------------------------------------------------------------
test("the cache reads only what changed, keeps what has gone and outlives a restart", async () => {
  const b = await board();
  const p = path.join(b.home, ".claude", "projects", "p");
  const s1 = path.join(p, "s1.jsonl"), s2 = path.join(p, "s2.jsonl");
  const at = day(1) + "T10:00:00Z";
  put(s1, [claude("m1", at, [1, 2, 3, 4]), claude("m2", at, [0, 0, 0, 10]), claude("m3", at, [0, 0, 0, 100])]);
  put(s2, [claude("m4", at, [0, 0, 0, 1000], "short")]);
  stamp(s1, ROUND); stamp(s2, ROUND);
  await b.start();
  assert.equal(await b.total(), 1120);
  const offsetOf = file => JSON.parse(fs.readFileSync(b.cache, "utf8")).files[file].offset;
  assert.equal(offsetOf(s1), fs.statSync(s1).size);

  // same size, same stamp: not opened, so the new number is not seen
  swap(s2, '"output_tokens":1000', '"output_tokens":5000');
  stamp(s2, ROUND);
  assert.equal(await b.total(), 1120);
  // a new stamp opens it, and its changed first bytes send it back to the start
  stamp(s2, ROUND + 10);
  assert.equal(await b.total(), 5120);

  // an append is read from where the last read stopped: a number changed
  // earlier in the file, past its first bytes, is never read again
  swap(s1, '"output_tokens":10}', '"output_tokens":90}');
  append(s1, claude("m5", at, [0, 0, 0, 7]) + "\n");
  assert.equal(await b.total(), 5127);
  assert.equal(offsetOf(s1), fs.statSync(s1).size);

  // a line still being written waits for its newline
  const line = claude("m6", at, [0, 0, 0, 30]);
  append(s1, line.slice(0, 60));
  assert.equal(await b.total(), 5127);
  append(s1, line.slice(60) + "\n");
  assert.equal(await b.total(), 5157);

  // a file shorter than what was read of it is counted again from the start
  put(s1, [claude("m7", at, [0, 0, 0, 2], "short")]);
  assert.equal(await b.total(), 5002);

  // a deleted log keeps the counts it had
  fs.unlinkSync(s2);
  assert.equal(await b.total(), 5002);

  // a restarted board carries on from the cache file without reopening
  stamp(s1, ROUND);
  assert.equal(await b.total(), 5002);
  await b.stop();
  swap(s1, '"output_tokens":2}', '"output_tokens":8}');
  stamp(s1, ROUND);
  await b.start();
  assert.equal(await b.total(), 5002);
});

// ---- midnight -------------------------------------------------------------------------
test("a day is the local calendar day, and a new zone counts the logs again", async () => {
  const b = await board();
  const d = day(3);
  const prev = new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
  const next = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
  put(path.join(b.home, ".claude", "projects", "p", "s.jsonl"), [
    claude("m1", d + "T06:59:30Z", [0, 0, 0, 7]),
    claude("m2", d + "T07:00:30Z", [0, 0, 0, 11]),
  ]);
  put(path.join(b.home, ".codex", "sessions", "rollout-k.jsonl"), [
    record("r1", d + "T18:29:00.500Z", 3, 0, 0),
    record("r2", d + "T18:31:00.500Z", 5, 0, 0),
  ]);
  const seen = async () => {
    const days = byDay(await b.days(10));
    return { [prev]: days[prev].total, [d]: days[d].total, [next]: days[next].total };
  };
  await b.start({ TZ: "UTC" });
  assert.deepEqual(await seen(), { [prev]: 0, [d]: 26, [next]: 0 });
  // seven hours behind UTC all year: 06:59:30 is the evening before
  await b.stop();
  await b.start({ TZ: "America/Phoenix" });
  assert.deepEqual(await seen(), { [prev]: 7, [d]: 19, [next]: 0 });
  // five and a half hours ahead: 18:29 and 18:31 fall either side of midnight
  await b.stop();
  await b.start({ TZ: "Asia/Kolkata" });
  assert.deepEqual(await seen(), { [prev]: 0, [d]: 21, [next]: 5 });
});

// ---- the folders -----------------------------------------------------------------------
test("no log folders at all is a year of zeros, not an error", async () => {
  const b = await board();
  await b.start();
  const answer = await b.days(7);
  assert.equal(answer.days.length, 7);
  assert.ok(answer.days.every(d => d.total === 0));
  assert.equal(answer.total, 0);
  assert.deepEqual(answer.found, { claude: false, codex: false });
});

test("run.config.json and the tools' own variables name other folders", async () => {
  const at = day(0) + "T00:00:00Z";
  const b = await board();
  // the config names a folder for Claude Code, turns Codex off, and a log in
  // the standard places is then not read
  const cfg = { token_logs: { claude: path.join(b.dir, "elsewhere"), codex: [] } };
  fs.writeFileSync(path.join(b.dir, "run.config.json"), JSON.stringify(cfg));
  put(path.join(b.dir, "elsewhere", "s.jsonl"), [claude("m1", at, [0, 0, 0, 4])]);
  put(path.join(b.home, ".claude", "projects", "p", "s.jsonl"), [claude("m2", at, [0, 0, 0, 40])]);
  put(path.join(b.home, ".codex", "sessions", "rollout.jsonl"), [record("r1", at, 5, 0, 0)]);
  await b.start();
  assert.deepEqual((await b.days(1)).tools, { claude: 4, codex: 0 });
  // the config is read fresh: taken away, the standard places count again,
  // and the folder it named no longer does
  fs.unlinkSync(path.join(b.dir, "run.config.json"));
  assert.deepEqual((await b.days(1)).tools, { claude: 40, codex: 5 });
  // CLAUDE_CONFIG_DIR and CODEX_HOME move the folders the way they move the tools
  await b.stop();
  put(path.join(b.dir, "cc", "projects", "p", "s.jsonl"), [claude("m3", at, [0, 0, 0, 400])]);
  put(path.join(b.dir, "cx", "archived_sessions", "rollout.jsonl"), [record("r2", at, 50, 0, 0)]);
  await b.start({ CLAUDE_CONFIG_DIR: path.join(b.dir, "cc"), CODEX_HOME: path.join(b.dir, "cx") });
  assert.deepEqual((await b.days(1)).tools, { claude: 400, codex: 50 });
});
