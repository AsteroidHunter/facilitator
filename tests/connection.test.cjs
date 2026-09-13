// The connection: the commands an agent runs inside its own turn, the link that
// holds the poll, the outbox that survives a lost answer, and work tracking that
// never asks the model for a heartbeat.
//
// A fixture board on a free port, a connection home in a temp folder, and
// invented cards. Nothing here touches the live board, the owner's data, port
// 8877, or any conversation.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn, execFile } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONNECT = path.join(ROOT, "facilitator-connect");
const LANE = "facilitator";

let outer;
let app;
let connectHome;
let port;
let origin;
let child;
let configPath;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One running link, with its output drained as it arrives. stop() waits for an
// exit only when the process has not already exited: awaiting a second exit
// event for a process that is already gone never resolves.
function startLink(extraEnv = {}) {
  const child = spawn("python3", [CONNECT, "--owner", LANE, "--board", origin, "connect"], {
    env: { ...process.env, FACILITATOR_CONNECT_HOME: connectHome,
           FACILITATOR_CONNECT_CONFIG: configPath, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const link = { child, out: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { link.out += chunk; });
  }
  link.ready = async (deadlineMs = 15000) => {
    const until = Date.now() + deadlineMs;
    while (!link.out.includes("generation") && child.exitCode === null && Date.now() < until) {
      await sleep(100);
    }
    assert.match(link.out, /session s-[0-9a-f]{10}, generation \d+, mode select/,
                 `the link did not take the lane:\n${link.out}`);
  };
  link.stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), sleep(5000)]);
    }
  };
  return link;
}

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

// the command under test, run the way an agent would run it inside a turn
function connect(args, extraEnv = {}) {
  return new Promise(resolve => {
    execFile("python3", [CONNECT, "--owner", LANE, "--board", origin, ...args], {
      env: { ...process.env, FACILITATOR_CONNECT_HOME: connectHome,
             FACILITATOR_CONNECT_CONFIG: configPath, ...extraEnv },
      timeout: 30000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  const type = response.headers.get("content-type") || "";
  return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
}
const post = (route, body) => api(route, { method: "POST", body });

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-conn-"));
  app = path.join(outer, "app");
  connectHome = path.join(outer, "connect-home");
  await mkdir(app);
  await mkdir(connectHome);
  // an invented lane config, so the adapter path runs without a config file
  // being written into the repository
  configPath = path.join(outer, "run.config.json");
  await writeFile(configPath, JSON.stringify({
    lanes: [{ owner: LANE, agent: "claude", adapter: { name: "monitor" } }],
  }));
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture patch did not apply");
  await writeFile(path.join(app, "server.py"), patched);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "connection fixture",
    items: [
      { id: "m5", bucket: "work", title: "Chimney sweep booking", owner: LANE },
      { id: "m6", bucket: "work", title: "Bike chain replacement", owner: LANE },
    ],
  }));
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
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await sleep(25);
  }
  await post(`/mode?owner=${LANE}&mode=select`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("whoami names the board, the lane and one session it keeps", async () => {
  const first = await connect(["whoami", "--json"]);
  assert.equal(first.code, 0, first.stderr);
  const who = JSON.parse(first.stdout);
  assert.equal(who.lane, LANE);
  assert.equal(who.board, origin);
  assert.match(who.session, /^s-[0-9a-f]{10}$/);
  // the session is minted once and reused, so the board can tell one
  // connection from another across commands
  const again = JSON.parse((await connect(["whoami", "--json"])).stdout);
  assert.equal(again.session, who.session);
});

test("the queue prints rows and never a message", async () => {
  const secret = "the sweep wants to come on a Tuesday before nine";
  assert.equal((await post(`/send?box=m5`, secret)).status, 200);
  assert.equal((await post(`/send?box=m6`, "the chain is skipping on the small ring")).status, 200);
  const listed = await connect(["queue"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /Chimney sweep booking/);
  assert.match(listed.stdout, /2 waiting/);
  assert.ok(!listed.stdout.includes("Tuesday"), "the printed queue carried a message");
  assert.ok(!listed.stdout.includes("skipping"), "the printed queue carried a message");
});

test("select takes the row tag from its own listing, and open acknowledges the delivery", async () => {
  const chosen = await connect(["select", "m5"]);
  assert.equal(chosen.code, 0, chosen.stderr);
  assert.match(chosen.stdout, /reserved m5/);
  const opened = await connect(["open", "m5"]);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /Tuesday before nine/);
  // the receipt went with it, so the claim is no longer provisional
  const listed = (await api(`/queue?owner=${LANE}`)).body;
  assert.equal(listed.held.box, "m5");
  assert.equal(listed.held.acknowledged, true, "open did not send the receipt");
});

test("a reply without a context strip is refused by the client", async () => {
  const bare = await connect(["reply", "m5", "Booked for Tuesday."]);
  assert.notEqual(bare.code, 0, "a reply with no context strip was accepted");
  assert.match(bare.stderr, /--ctx/);
});

test("a reply lands once and leaves no unresolved receipt", async () => {
  const answered = await connect(["reply", "m5", "Booked for Tuesday at eight.",
                                  "--ctx", "arranging the annual sweep"]);
  assert.equal(answered.code, 0, answered.stderr);
  const told = JSON.parse((await connect(["status", "--json"])).stdout);
  assert.deepEqual(told.unresolved, [], "the outbox kept an entry for a settled reply");
  const card = (await api("/state")).body.boxes.find(b => b.id === "m5");
  assert.equal(card.replies, 1);
  assert.equal(card.replyFull, "Booked for Tuesday at eight.");
});

test("an operation id is written down before the send and cleared after it", async () => {
  // the outbox is a retry buffer and nothing more, so it is empty once the
  // board has answered and the board stays the only source of truth
  const files = await readdir(path.join(connectHome, LANE));
  assert.ok(files.includes("session"), "no session was kept");
  const outbox = path.join(connectHome, LANE, "outbox.jsonl");
  const kept = await readFile(outbox, "utf8").catch(() => "");
  assert.equal(kept.trim(), "", "the outbox still holds a settled entry");
});

test("a command with no link says plainly that work tracking is degraded", async () => {
  await connect(["select", "m6"]);
  await connect(["open", "m6"]);
  const started = await connect(["work", "start", "m6", "--job", "j-chain"]);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, /work tracking is degraded/);
  const card = (await api("/state")).body.boxes.find(b => b.id === "m6");
  assert.equal(card.state, "working");
  assert.deepEqual(card.work, ["j-chain"]);
});

test("work end clears the job it names and no path asks the model for a heartbeat", async () => {
  const ended = await connect(["work", "end", "m6", "--job", "j-chain"]);
  assert.equal(ended.code, 0, ended.stderr);
  const card = (await api("/state")).body.boxes.find(b => b.id === "m6");
  assert.deepEqual(card.work, []);
  const source = await readFile(CONNECT, "utf8");
  // the heartbeat lives in the link's own clock, never in a command an agent runs
  const beats = source.split("\n").filter(line => line.includes('"/ping"'));
  assert.equal(beats.length, 1, "more than one place sends a beat");
  assert.match(source.slice(0, source.indexOf(beats[0])).split("class ").pop(), /^Work\b/,
               "the beat is not inside the connection's own work tracker");
});

test("a card in another lane is told apart from a refusal", async () => {
  const missing = await connect(["select", "nope"]);
  assert.equal(missing.code, 4, missing.stderr);
  assert.match(missing.stderr, /not a card this lane may choose/);
});

test("a release gives the card back and the exit code says it went through", async () => {
  const given = await connect(["release", "m6", "--reason", "waiting on a part"]);
  assert.equal(given.code, 0, given.stderr);
  const listed = (await api(`/queue?owner=${LANE}`)).body;
  assert.equal(listed.held, null);
  assert.ok(listed.cards.some(c => c.box === "m6"));
});

test("the link takes the lane, serves status over its endpoint, and a second one exits", async () => {
  const link = startLink();
  try {
    await link.ready();
    // the commands share the running link, which is how they share its session,
    // its outbox and its work tracker
    const told = JSON.parse((await connect(["status", "--json"])).stdout);
    assert.equal(told.link, true, "the command did not find the running link");
    assert.equal(told.mode, "select");
    // a second connection for one lane is told who holds it and exits
    const second = await connect(["connect"], { FACILITATOR_CONNECT_HOME: path.join(outer, "second-home") });
    assert.equal(second.code, 7, second.stdout + second.stderr);
    assert.match(second.stderr, /already held/);
    assert.match(second.stderr, /nothing was changed/);
  } finally {
    await link.stop();
  }
});

test("a notification runs the adapter and the outcome is recorded after it returns", async () => {
  const link = startLink();
  try {
    await link.ready();
    assert.equal((await post(`/send?box=m6`, "the chain needs a new quick link")).status, 200);
    const until = Date.now() + 20000;
    while (!link.out.includes("cards waiting") && !link.out.includes("card waiting") && Date.now() < until) {
      await sleep(200);
    }
    // counts and the lane, and never a word of the card itself
    assert.match(link.out, /facilitator: 1 card waiting on facilitator, oldest \d+s\./);
    assert.ok(!link.out.includes("quick link"), "the adapter line carried the message");
    // the notice was created pending and closed only after the adapter returned
    const saved = JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
    const notices = saved.notices[LANE] || [];
    const closed = notices.filter(n => n.state === "closed");
    assert.ok(closed.length >= 1, "no notice outcome was recorded");
    assert.equal(closed.at(-1).adapter, "monitor");
    assert.equal(closed.at(-1).outcome, "accepted");
    assert.ok(closed.at(-1).outcome_ts >= closed.at(-1).ts, "the outcome predates the notice");
  } finally {
    await link.stop();
  }
});

test("the link ends a watched job when its process goes, with no beat from the model", async () => {
  const sleeper = spawn("sleep", ["120"]);
  const link = startLink();
  try {
    await link.ready();
    await connect(["select", "m6"]);
    await connect(["open", "m6"]);
    const started = await connect(["work", "start", "m6", "--job", "j-watched", "--pid", String(sleeper.pid)]);
    assert.equal(started.code, 0, started.stderr);
    assert.ok(!started.stderr.includes("degraded"), "the link was running but the command said otherwise");
    const watched = JSON.parse((await connect(["status", "--json"])).stdout);
    assert.ok(Object.keys(watched.jobs).includes("j-watched"), "the link is not watching the job");
    assert.equal((await api("/state")).body.boxes.find(b => b.id === "m6").state, "working");
    // the process goes, and the connection ends the job itself. Nothing asked
    // the model for a beat at any point
    sleeper.kill("SIGKILL");
    await once(sleeper, "exit");
    const gone = Date.now() + 60000;
    for (;;) {
      const card = (await api("/state")).body.boxes.find(b => b.id === "m6");
      if ((card.work || []).length === 0) break;
      assert.ok(Date.now() < gone, `the link never ended a job whose process had gone:\n${link.out}`);
      await sleep(500);
    }
    assert.match(link.out, /job j-watched on m6 ended, its process is gone/);
  } finally {
    await link.stop();
    if (sleeper.exitCode === null) sleeper.kill("SIGKILL");
  }
});

// ---- what carries an operation id, and what does not ------------------------

test("exactly the commands that owe a receipt mint one, and no others", async () => {
  const source = await readFile(CONNECT, "utf8");
  const named = source.match(/RECEIPTED = frozenset\(\{([^}]*)\}\)/s)[1];
  const carry = [...named.matchAll(/"([a-z-]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(carry, ["note", "notified", "open", "opened", "progress", "release",
                           "reply", "select", "work-end", "work-start"],
                   "the set of receipted commands has drifted from the contract");
  // a read and a rename carry none: asking twice is the same question, and
  // renaming a card twice under one name is the same card with that name
  await connect(["title", "m5", "Chimney sweep booking"]);
  const outbox = await readFile(path.join(connectHome, LANE, "outbox.jsonl"), "utf8").catch(() => "");
  assert.equal(outbox.trim(), "", "a read or a rename left an operation id behind");
});

test("an unsettled effect is retried under its own id, and a lost position is dropped", async () => {
  const outbox = path.join(connectHome, LANE, "outbox.jsonl");
  // an entry each: one effect the board never heard of, one stale position
  await writeFile(outbox, [
    JSON.stringify({ op: "note-abc123abc123", kind: "note", route: "/note",
                     query: { session: JSON.parse((await connect(["whoami", "--json"])).stdout).session, box: "m5" },
                     body: "Left over from a connection that stopped mid-send.", ts: Date.now() / 1000 }),
    JSON.stringify({ op: "select-abc123abc1", kind: "select", route: "/select",
                     query: { box: "m5", row: "deadbeefdead" }, body: "", ts: Date.now() / 1000 }),
  ].join("\n") + "\n");
  const link = startLink();
  try {
    await link.ready();
    const until = Date.now() + 15000;
    while ((await readFile(outbox, "utf8").catch(() => "")).trim() !== "" && Date.now() < until) {
      await sleep(200);
    }
    assert.equal((await readFile(outbox, "utf8").catch(() => "")).trim(), "",
                 `the outbox was not reconciled at start:\n${link.out}`);
    // the effect landed exactly once, under the id it was written down with
    const card = (await api("/state")).body.boxes.find(b => b.id === "m5");
    assert.equal(card.replyFull, "Left over from a connection that stopped mid-send.");
    const saved = JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
    assert.equal(saved.ops["note-abc123abc123"].kind, "note");
    // the position receipt was dropped rather than sent: the place it named is
    // gone, and asking again would only be told so
    assert.equal(saved.ops["select-abc123abc1"], undefined, "a stale selection was sent anyway");
  } finally {
    await link.stop();
  }
});

test("an adapter with no supported route is recorded as refused, not as delivered", async () => {
  const alertConfig = path.join(outer, "alert.config.json");
  await writeFile(alertConfig, JSON.stringify({
    lanes: [{ owner: LANE, agent: "claude", adapter: { name: "owner-alert" } }],
  }));
  // a message landing on the card a lane already holds raises no notice, since
  // it is reachable by opening with fresh=1. So nothing may be held here
  const held = (await api(`/queue?owner=${LANE}`)).body.held;
  if (held) assert.equal((await connect(["release", held.box])).code, 0);
  const link = startLink({ FACILITATOR_CONNECT_CONFIG: alertConfig });
  try {
    await link.ready();
    assert.equal((await post(`/send?box=m6`, "the gate latch has seized")).status, 200);
    const until = Date.now() + 20000;
    while (!link.out.includes("cannot be reached") && Date.now() < until) await sleep(200);
    assert.match(link.out, /lane facilitator cannot be reached/);
    assert.ok(!link.out.includes("seized"), "the alert carried the message");
    const saved = JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
    const last = (saved.notices[LANE] || []).filter(n => n.state === "closed").at(-1);
    assert.equal(last.adapter, "owner-alert");
    assert.equal(last.outcome, "refused", "a surface with no route was recorded as delivered");
  } finally {
    await link.stop();
  }
});

test("no adapter, client or fallback reaches for MCP", async () => {
  const shipped = [CONNECT, path.join(ROOT, "server.py"), path.join(ROOT, "run.config.example.json")];
  for (const file of shipped) {
    const text = await readFile(file, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (!/\bmcp\b/i.test(line)) continue;
      // the constraint may be stated; it may not be used
      assert.match(line, /permanent|constraint|never|without|no MCP|excluded|not require/i,
                   `${path.basename(file)}:${index + 1} reaches for MCP: ${line.trim()}`);
    }
  }
});
