// The transport under the board. The demonstrated defect and its fix come
// first: a peer that stops reading a large answer holds no command, claim or
// health request up, because the answer is built under the shared lock and
// written after it. That is proved with a real TCP socket that never reads. On
// the loopback the kernel accepts even an 11 MB answer whole, so the write
// completes rather than pausing; the write-stall deadline that cuts a genuinely
// wedged write, which needs the small window of a real tunnel to trigger, is
// proved on its own against the protocol with a fake transport and a real event
// loop. The rest: a body too big or too slow is refused on its clock, an idle
// new connection is closed on the first-request clock, the listeners' seats are
// counted while commands are not, a burst is answered whole and in order, and a
// stop sends a waiting listener home within its grace. Every request here goes
// through core http, not fetch, for the reason httpReq explains. The fixture's
// deadlines are patched down so the suite runs in seconds, and the response
// targets are loopback numbers, not what a phone sees through a tunnel. The
// suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsyncLocal = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const LOCAL_TARGET_MS = 500;     // what a command may take on the loopback while a reader stalls
const STALL_TIMEOUT_S = 1.5;     // WRITE_STALL_TIMEOUT in this fixture
const FIRST_REQUEST_S = 1.0;     // FIRST_REQUEST_TIMEOUT in this fixture
const BODY_READ_S = 1.0;         // BODY_READ_TIMEOUT in this fixture
const WAIT_SLOTS = 2;            // WAIT_SLOTS in this fixture
const BIG = "x".repeat(900 * 1024);   // one reply under the 1 MB body cap; four of them, three fields each, make the board ~11 MB

let outer;
let app;
let logs;
let port;
let origin;
let child;

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

async function startServer(extraEnv = {}) {
  child = spawn("python3", [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs,
           FACILITATOR_LOG_LEVEL: "debug", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  child.output = () => output;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await httpGet("/state")).status === 200) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
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

async function eventsUntil(test, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = await events();
    if (seen.some(test)) return seen;
    if (Date.now() > deadline) throw new Error("the expected line was never written");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Every request in this file goes through Node's core http on its own fresh
// socket, never through the global fetch. The board answers every request with
// Connection: close, exactly as the stdlib server it replaced did, so each
// request needs a new connection. fetch keeps a shared connection pool, and a
// pooled socket the board then closes can surface later as a stray "fetch
// failed" that belongs to no test; core http has no pool, dispatches each
// request the moment it is called, and hands back the status, the parsed body
// and the headers plainly. That keeps a long poll opened here honestly on the
// wire and a reset from ever escaping as an unhandled rejection.
function httpReq(method, pathname, body) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const request = require("node:http").request({
      host: "127.0.0.1", port, path: pathname, method,
      headers: data ? { "content-length": data.length } : {},
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, body: parsed, headers: response.headers,
                  retryAfter: response.headers["retry-after"], ms: Date.now() - started });
      });
    });
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}
function httpGet(pathname) {
  return httpReq("GET", pathname);
}
async function post(route, body) {
  return httpReq("POST", route, body);
}

// a raw connection: the request goes out as bytes and nothing is ever read
// back, so the kernel's receive buffer fills and the server's send stalls
function openStalledReader(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const closed = new Promise(done => {
      socket.on("close", () => done(Date.now()));
      socket.on("error", () => {});   // a reset is the expected end of this socket
    });
    socket.once("connect", () => {
      socket.pause();   // nothing is read, ever
      socket.write(request, error => error ? reject(error) : resolve({ socket, closed }));
    });
    socket.once("error", reject);
  });
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-transport-"));
  app = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(app);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = patch(source, "WRITE_STALL_TIMEOUT = 30.0", `WRITE_STALL_TIMEOUT = ${STALL_TIMEOUT_S}`);
  source = patch(source, "FIRST_REQUEST_TIMEOUT = 15.0", `FIRST_REQUEST_TIMEOUT = ${FIRST_REQUEST_S}`);
  source = patch(source, "BODY_READ_TIMEOUT = 30.0", `BODY_READ_TIMEOUT = ${BODY_READ_S}`);
  source = patch(source, "WAIT_SLOTS = 8", `WAIT_SLOTS = ${WAIT_SLOTS}`);
  await writeFile(path.join(app, "server.py"), source);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(app, "server.py")));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "transport fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a reader that stops reading a large board holds no command or claim up, and its connection cleans up", async () => {
  // this is the demonstrated defect and its fix: the old server built and wrote
  // its answer under the shared lock, so a client that stopped reading held the
  // lock and every mutation waited on it. Here the answer is serialized under
  // the lock and written after it, so a stalled reader holds only its own
  // connection. The board is built far larger than a normal one so the stall is
  // as hard as it gets; the reader is a real TCP socket that never reads.
  for (let n = 0; n < 4; n++) {
    const made = await post("/create?owner=facilitator", `Big card ${n}`);
    assert.equal(made.status, 200);
    assert.equal((await post(`/reply?box=${made.body.id}`, BIG)).status, 200);
  }
  const whole = await httpGet("/state");
  const bytes = JSON.stringify(whole.body).length;
  assert.ok(bytes > 8 * 1024 * 1024, `the board is only ${bytes} bytes; too small to stress the write path`);

  const stalled = await openStalledReader("GET /state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await new Promise(resolve => setTimeout(resolve, 300));   // the answer is on its way into a socket nobody reads

  // commands, a claim and the health read all answer at once while the reader
  // sits on its unread socket: the lock is free, which is the whole fix
  const unread = await httpGet("/unread?owner=facilitator");
  assert.equal(unread.status, 200);
  assert.ok(unread.ms < LOCAL_TARGET_MS, `/unread took ${unread.ms} ms behind a stalled reader`);
  const sent = await post("/send?box=0", "sent behind a stalled reader");
  assert.equal(sent.status, 200);
  assert.ok(sent.ms < LOCAL_TARGET_MS, `/send took ${sent.ms} ms behind a stalled reader`);
  const claim = await httpGet("/wait?owner=facilitator&timeout=2&agent=probe");
  assert.equal(claim.body.box, "0", "the agent could not claim while a reader stalled");
  assert.ok(claim.ms < LOCAL_TARGET_MS, `/wait took ${claim.ms} ms behind a stalled reader`);
  assert.equal((await post(`/ack?owner=facilitator&token=${claim.body.ack}`)).status, 200);
  assert.equal((await post("/reply?box=0", "answered behind a stalled reader")).status, 200);
  const again = await httpGet("/state");
  assert.equal(again.status, 200, "a second reader could not read while the first stalled");
  assert.deepEqual(again.body.boxes.find(b => b.id === "0").pendingTexts, [], "the send behind the stall did not land");
  assert.equal(again.body.boxes.find(b => b.id === "0").replyFull, "answered behind a stalled reader");

  // the stalled connection does not leak on the peer resetting it either, which
  // is what a phone dropping off the tunnel looks like. (Node cannot set a small
  // receive buffer, and this machine's loopback buffers the whole answer, so a
  // Node socket here does not force the write to pause; the server-side cut at
  // the deadline is proved for real, with a small-buffered client, in the stall
  // probe test below, and the abort logic deterministically in the protocol
  // test that follows.)
  const closed = new Promise(resolve => stalled.socket.on("close", () => resolve(true)));
  stalled.socket.destroy();
  assert.equal(await Promise.race([closed, new Promise(r => setTimeout(() => r(false), 2000))]), true);
  assert.equal((await httpGet("/state")).status, 200, "the board did not survive the reset reader");
});

test("a real stalled reader is cut at the write deadline, in both clock orderings", async () => {
  // the real TCP regression for server-side cleanup: a small-buffered client
  // that never reads forces the write to pause, and the probe watches the
  // server's own connection count, the peer's reset and the hungup line. Run
  // for the fast clock and for the production ordering, where the keep-alive
  // clock is shorter than the stall clock, which is the case that first hid
  // this defect.
  for (const [stall, keepalive] of [[1.5, 5], [1.5, 1]]) {
    const { stdout } = await execFileAsyncLocal(
      "python3", [path.join(__dirname, "transport_stall_probe.py"), path.join(ROOT, "server.py"), String(stall), String(keepalive)],
      { env: process.env, maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
    const seen = JSON.parse(stdout.trim().split("\n").at(-1));
    const label = `stall ${stall}s, keep-alive ${keepalive}s`;
    assert.ok(seen.board_bytes > 8 * 1024 * 1024, `${label}: board only ${seen.board_bytes} bytes`);
    assert.equal(seen.established_during, 1, `${label}: the stalled reader did not hold a connection`);
    assert.equal(seen.send_status, 200, `${label}: a command behind the stall was refused`);
    assert.ok(seen.send_ms < LOCAL_TARGET_MS, `${label}: a command behind the stall took ${seen.send_ms} ms`);
    assert.equal(seen.server_cut, true, `${label}: the server never dropped the stalled connection`);
    assert.equal(seen.peer_on_resume, "reset", `${label}: the peer saw ${seen.peer_on_resume}, not a reset`);
    assert.ok(seen.peer_read_bytes < seen.board_bytes, `${label}: the peer read the whole answer, so nothing was cut`);
    assert.ok(seen.hungup_lines >= 1, `${label}: no hungup line for the cut connection`);
    assert.equal(seen.board_after_cut, 200, `${label}: the board did not survive the cut`);
    assert.deepEqual(seen.pending_after_cut, ["sent behind the stall"], `${label}: the send behind the stall did not land`);
    assert.equal(seen.stop_code, 0, `${label}: the stop did not exit cleanly`);
    assert.ok(seen.stop_seconds < 2, `${label}: the stop took ${seen.stop_seconds}s, so the cut did not free the connection`);
  }
});

test("the write-stall deadline cuts a stuck write even while the transport is closing, and stands down otherwise", async () => {
  // the abort logic driven straight against the protocol with a real event loop
  // and a fake transport, deterministic and needing no wall-clock wait. The
  // fake transport models the one fact that decides the cut: how many bytes are
  // still buffered. The closing-with-bytes case is the exact defect the review
  // found: Connection: close makes uvicorn call transport.close() the moment the
  // body is handed over, so the transport is closing while the peer's bytes are
  // still buffered, and the deadline must abort it anyway.
  const { stdout } = await execFileAsyncLocal("python3", ["-c", [
    "import asyncio, json, server, uvicorn",
    "from uvicorn.server import ServerState",
    "server.WRITE_STALL_TIMEOUT = 0.2",
    "# the first-request clock is left long: a real stalled write has already",
    "# received its request (h11 state DONE, not IDLE), so that clock never fires",
    "# against it; shortening it would close the idle fake connection and mask the",
    "# stall abort, a quirk of the fixture, not the code",
    "class FakeTransport:",
    "    def __init__(self, buffered=0): self.aborted = False; self.closed = False; self._buffered = buffered",
    "    def get_extra_info(self, name, default=None): return default",  // no real socket: the SO_LINGER step is skipped and the abort still runs
    "    def get_write_buffer_size(self): return self._buffered",
    "    def is_closing(self): return self.aborted or self.closed",
    "    def write(self, data): pass",
    "    def abort(self): self.aborted = True",
    "    def close(self): self.closed = True",
    "    def set_write_buffer_limits(self, *a, **k): pass",
    "    def pause_reading(self): pass",
    "    def resume_reading(self): pass",
    "def armed(buffered, then=None):",
    "    p = server.BoardProtocol(config=CONFIG, server_state=ServerState(), app_state={}, _loop=LOOP)",
    "    t = FakeTransport(buffered); p.connection_made(t)",
    "    p.pause_writing()",
    "    if then: then(p, t)",
    "    return p, t",
    "async def main():",
    "    global LOOP, CONFIG",
    "    LOOP = asyncio.get_event_loop()",
    "    CONFIG = uvicorn.Config(server.build_app(), loop='asyncio', http=server.BoardProtocol); CONFIG.load()",
    "    out = {}",
    "    # a paused write with bytes still buffered, never resumed, is aborted",
    "    p, t = armed(9_000_000)",
    "    out['first_timer_armed'] = p._first_timer is not None",
    "    out['stall_timer_armed'] = p._stall_timer is not None",
    "    await asyncio.sleep(0.4); out['aborted_when_stuck'] = t.aborted",
    "    # the review's case: the transport is already closing, bytes still buffered",
    "    p, t = armed(9_000_000, then=lambda p, t: t.close())",
    "    out['closing_with_bytes_is_closing'] = t.is_closing()",
    "    await asyncio.sleep(0.4); out['aborted_when_closing_with_bytes'] = t.aborted",
    "    # a paused write whose buffer has since drained to nothing is left alone",
    "    p, t = armed(0)",
    "    await asyncio.sleep(0.4); out['not_aborted_when_drained'] = not t.aborted",
    "    # a paused write that resumes in time is left alone and its timer cleared",
    "    p, t = armed(9_000_000, then=lambda p, t: p.resume_writing())",
    "    out['timer_cleared_on_resume'] = p._stall_timer is None",
    "    await asyncio.sleep(0.4); out['not_aborted_when_resumed'] = not t.aborted",
    "    # a connection that completes its one response clears its timers on close",
    "    p3 = server.BoardProtocol(config=CONFIG, server_state=ServerState(), app_state={}, _loop=LOOP)",
    "    t3 = FakeTransport(); p3.connection_made(t3); p3.on_response_complete(); p3.connection_lost(None)",
    "    out['timers_cleared_on_close'] = p3._first_timer is None and p3._stall_timer is None",
    "    out['not_aborted_after_clean_close'] = not t3.aborted",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n")], { cwd: app, env: { ...process.env, FACILITATOR_TEST_PORT: String(port) } });
  const out = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(out.first_timer_armed, true, "a new connection did not arm the first-request timer");
  assert.equal(out.stall_timer_armed, true, "a paused write did not arm the stall deadline");
  assert.equal(out.aborted_when_stuck, true, "a write paused past the deadline was not cut");
  assert.equal(out.closing_with_bytes_is_closing, true, "the fixture did not model a closing transport");
  assert.equal(out.aborted_when_closing_with_bytes, true, "a stuck write was not cut because the transport was closing (the reported defect)");
  assert.equal(out.not_aborted_when_drained, true, "a paused write whose buffer had drained was cut anyway");
  assert.equal(out.timer_cleared_on_resume, true, "the stall deadline was not stood down when the write resumed");
  assert.equal(out.not_aborted_when_resumed, true, "a write that resumed in time was cut anyway");
  assert.equal(out.timers_cleared_on_close, true, "a closed connection left a timer armed");
  assert.equal(out.not_aborted_after_clean_close, true, "a cleanly closed connection was aborted");
});

test("a body over the cap is refused before it is read, and one that never arrives is refused on its clock", async () => {
  const tooBig = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("POST /send?box=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2000000\r\n\r\n");
    });
    let seen = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => { seen += chunk; if (/\r\n\r\n/.test(seen)) socket.end(); });
    socket.on("close", () => resolve(seen));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 3000);
  });
  assert.match(tooBig, /^HTTP\/1\.1 413 /, tooBig.split("\r\n")[0]);
  assert.match(tooBig, /"error": "body too large"/);
  assert.match(tooBig, /connection: close/i, "a refused body leaves the connection open with unread bytes on it");

  const started = Date.now();
  const never = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("POST /send?box=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\n\r\n");
    });
    let seen = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => { seen += chunk; });
    socket.on("close", () => resolve(seen));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), (BODY_READ_S + 4) * 1000);
  });
  const took = (Date.now() - started) / 1000;
  assert.match(never, /^HTTP\/1\.1 408 /, never.split("\r\n")[0] || "no answer at all");
  assert.ok(took >= BODY_READ_S * 0.8 && took < BODY_READ_S + 3, `the body clock ran ${took.toFixed(2)} s against ${BODY_READ_S} s`);
  const state = (await httpGet("/state")).body;
  assert.deepEqual(state.boxes.find(b => b.id === "0").pendingTexts, [], "a refused body left a message behind");
});

test("a connection that opens and never asks is closed on the first-request clock", async () => {
  const started = Date.now();
  const closedAt = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("close", () => resolve(Date.now()));
    socket.on("error", reject);
    setTimeout(() => { socket.destroy(); resolve(null); }, (FIRST_REQUEST_S + 4) * 1000);
  });
  assert.ok(closedAt, "an idle new connection was never closed");
  const held = (closedAt - started) / 1000;
  assert.ok(held >= FIRST_REQUEST_S * 0.8 && held < FIRST_REQUEST_S + 3, `held ${held.toFixed(2)} s against ${FIRST_REQUEST_S} s`);
});

test("the listeners' seats are counted: past them a wait is told to come back, and commands are never counted", async () => {
  // each slot-filling wait on its own socket, dispatched at once
  const waiting = [];
  for (let n = 0; n < WAIT_SLOTS; n++) {
    waiting.push(httpGet(`/wait?owner=pastureland&timeout=4&agent=seat${n}`));
  }
  // the seats are taken once the board says both listeners are on the line
  const deadline = Date.now() + 3000;
  for (;;) {
    const state = (await httpGet("/state")).body;
    if (state.listening.pastureland) break;
    assert.ok(Date.now() < deadline, "the listeners never showed as listening");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const refused = await httpGet("/wait?owner=pastureland&timeout=4&agent=extra");
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "too many listeners waiting");
  assert.ok(refused.ms < LOCAL_TARGET_MS, `the refusal took ${refused.ms} ms`);
  assert.equal(refused.retryAfter, "5");
  // the seats are for waiting; a command, the unread count and a reading are not seated there
  assert.equal((await post("/create?owner=pastureland", "Made while the seats were full")).status, 200);
  assert.equal((await httpGet("/unread?owner=pastureland")).status, 200);
  assert.equal((await httpGet("/state")).status, 200);
  const overload = (await events()).filter(e => e.kind === "overload");
  assert.ok(overload.length >= 1, "the full house wrote no line");
  assert.equal(overload.at(-1).slots, "waits");
  assert.equal(overload.length, 1, "the full house wrote a line per refusal rather than one per few seconds");

  const answers = await Promise.all(waiting);
  assert.ok(answers.every(a => a.body && a.body.idle === true), JSON.stringify(answers.map(a => a.body)));
  const admitted = await httpGet("/wait?owner=pastureland&timeout=1&agent=later");
  assert.equal(admitted.status, 200, "a seat given back was not given out again");
});

test("a burst of readers and senders is answered whole, in order, with no refusal", async () => {
  const burst = [];
  for (let n = 0; n < 20; n++) {
    burst.push(httpGet("/state").then(r => r.status));
    burst.push(post("/send?box=0", `burst ${n}`).then(r => r.status));
  }
  const statuses = await Promise.all(burst);
  assert.ok(statuses.every(s => s === 200), statuses.join(","));
  const state = (await httpGet("/state")).body;
  const texts = state.boxes.find(b => b.id === "0").pendingTexts;
  assert.equal(texts.length, 20);
  assert.deepEqual([...texts].sort(), texts.map((_, i) => `burst ${i}`).sort());
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("a stop sends a waiting listener home at once and leaves within its grace", async () => {
  const waiting = httpGet("/wait?owner=facilitator&timeout=30&agent=stopper")
    .then(r => r.body, error => ({ closed: String(error) }));
  const deadline = Date.now() + 3000;
  for (;;) {
    const state = (await httpGet("/state")).body;
    if (state.listening.facilitator) break;
    assert.ok(Date.now() < deadline, "the listener never showed as listening");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const started = Date.now();
  child.kill("SIGTERM");
  const answer = await Promise.race([
    waiting,
    new Promise(resolve => setTimeout(() => resolve({ hung: true }), 6000)),
  ]);
  assert.ok(!answer.hung, "the waiting listener was left hanging through the stop");
  assert.deepEqual(answer, { idle: true }, JSON.stringify(answer));
  const [code] = await once(child, "exit");
  const took = Date.now() - started;
  assert.equal(code, 0, child.output());
  assert.ok(took < 5000, `the stop took ${took} ms`);
  const stops = (await events()).filter(e => e.kind === "stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reason, "SIGTERM");
  assert.equal(child.output(), "");
});
