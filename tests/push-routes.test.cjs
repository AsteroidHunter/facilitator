// The push side of the phone page, against a fixture server whose working
// flag expires in one second: the public key, the subscription store, the
// VAPID token openssl signs (verified with openssl), and the exact events
// that send a push: a plain reply with no live working flag, and a deferred
// turn handed over when its flag drops or expires. Notes never push.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// what a refusing push service says back, longer than the log keeps of it
const REFUSAL_BODY = "the vapid token was not accepted by this service: " + "x".repeat(400);

let child;
let outer;
let fixtureDir;
let logs;
let port;
let origin;
let pushService;      // the stub push service the subscriptions point at
let pushOrigin;
const pushes = [];    // every push the stub received: {path, headers, body}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

async function post(route, body) {
  return api(route, { method: "POST", body });
}

async function create(title) {
  const result = await post("/create?owner=facilitator", title);
  assert.equal(result.status, 200);
  return result.body.id;
}

async function stateFile() {
  return JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
}

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(text) {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function pushesAfter(count, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pushes.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} pushes, saw ${pushes.length}`);
}
async function noPushWithin(ms) {
  const before = pushes.length;
  await new Promise(resolve => setTimeout(resolve, ms));
  assert.equal(pushes.length, before, "a push went out where none should");
}

// the raw r||s signature a JWT carries, back to the DER openssl verifies
function derSignature(raw) {
  const int = part => {
    let bytes = Buffer.from(part);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32, 64))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

async function verifyVapid(header, expectedKey) {
  const match = /^vapid t=([^,]+), k=([^,\s]+)$/.exec(header);
  assert.ok(match, `not a vapid authorization header: ${header}`);
  const [, token, key] = match;
  assert.equal(key, expectedKey, "the push carried a different key from /push/key");
  const [head, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(fromB64url(head).toString()), { typ: "JWT", alg: "ES256" });
  const body = JSON.parse(fromB64url(claims).toString());
  assert.equal(body.aud, pushOrigin);
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600, "exp outside a day");
  assert.match(body.sub, /^(mailto:|https:)/);
  const raw = fromB64url(signature);
  assert.equal(raw.length, 64);
  const spki = Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), fromB64url(key)]);
  const pem = "-----BEGIN PUBLIC KEY-----\n" + spki.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----\n";
  const pubPath = path.join(fixtureDir, "pub.pem");
  const sigPath = path.join(fixtureDir, "sig.der");
  const msgPath = path.join(fixtureDir, "signing.txt");
  await writeFile(pubPath, pem);
  await writeFile(sigPath, derSignature(raw));
  await writeFile(msgPath, head + "." + claims);
  const verdict = execFileSync("openssl", ["dgst", "-sha256", "-verify", pubPath, "-signature", sigPath, msgPath], { encoding: "utf8" });
  assert.match(verdict, /Verified OK/);
}

// the board itself, started and stopped: one test needs the start line the next
// boot writes, so the fixture has to be able to come back up
async function startServer() {
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      const response = await fetch(origin + "/state");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

// every line the board has written, in order
async function events() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

// pushes go out on their own thread, so their lines arrive a moment later
async function pushLines(count, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const lines = (await events()).filter(event => event.kind === "push" || event.kind === "pushfail");
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) throw new Error(`expected ${count} push lines, saw ${lines.length}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-push-"));
  fixtureDir = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(fixtureDir);
  port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  let patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  const timed = patched.replace("BG_STALE = 75.0", "BG_STALE = 1.0");
  assert.notEqual(timed, patched, "the working flag's clock was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), timed);
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title: "push test", items: [] }));

  pushService = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      pushes.push({ path: req.url, headers: req.headers, body });
      if (req.url.startsWith("/refused")) {
        res.statusCode = 403;
        res.end(REFUSAL_BODY);
        return;
      }
      res.statusCode = req.url.startsWith("/gone") ? 410 : 201;
      res.end();
    });
  });
  await new Promise(resolve => pushService.listen(0, "127.0.0.1", resolve));
  pushOrigin = `http://127.0.0.1:${pushService.address().port}`;

  origin = `http://127.0.0.1:${port}`;
  await startServer();
});

after(async () => {
  await stopServer();
  if (pushService) await new Promise(resolve => pushService.close(resolve));
  if (outer) await rm(outer, { recursive: true, force: true });
});

let publicKey;

test("the public key is a P-256 point made by openssl into a private file beside state.json", async () => {
  const first = await api("/push/key");
  assert.equal(first.status, 200);
  publicKey = first.body.key;
  const point = fromB64url(publicKey);
  assert.equal(point.length, 65);
  assert.equal(point[0], 4, "not an uncompressed point");
  const again = await api("/push/key");
  assert.equal(again.body.key, publicKey, "the key changed between calls");
  const keyFile = await stat(path.join(fixtureDir, "vapid-key.pem"));
  assert.equal(keyFile.mode & 0o777, 0o600, "the key file is readable by others");
  const pem = await readFile(path.join(fixtureDir, "vapid-key.pem"), "utf8");
  assert.match(pem, /BEGIN EC PRIVATE KEY/);
  const ignored = await readFile(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignored, /^\/vapid-key\.pem$/m, "the key file is not gitignored");
});

test("subscriptions are stored one per endpoint and bad ones refused", async () => {
  assert.equal((await post("/push/subscribe", "not json")).status, 400);
  assert.equal((await post("/push/subscribe", JSON.stringify({ endpoint: "ftp://x" }))).status, 400);
  assert.equal((await post("/push/subscribe", JSON.stringify({ keys: {} }))).status, 400);
  const sub = { endpoint: pushOrigin + "/ok/one", expirationTime: null, keys: { p256dh: "abc", auth: "def" } };
  let result = await post("/push/subscribe", JSON.stringify(sub));
  assert.deepEqual(result, { status: 200, body: { ok: true, count: 1 } });
  result = await post("/push/subscribe", JSON.stringify(sub));
  assert.equal(result.body.count, 1, "the same endpoint was stored twice");
  const saved = (await stateFile()).push_subs;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].endpoint, sub.endpoint);
  assert.deepEqual(saved[0].keys, sub.keys);
});

test("a plain reply with no live working flag sends one signed, payload-less push", async () => {
  const id = await create("Push on reply");
  const before = pushes.length;
  assert.equal((await post(`/reply?box=${id}`, "Here is the answer")).status, 200);
  await pushesAfter(before + 1);
  assert.equal(pushes.length, before + 1, "more than one push for one hand-over");
  const push = pushes[before];
  assert.equal(push.path, "/ok/one");
  assert.equal(push.body, "", "a payload was sent");
  assert.equal(push.headers["content-length"], "0");
  assert.ok(Number(push.headers.ttl) > 0, "no TTL header");
  await verifyVapid(push.headers.authorization, publicKey);
  const state = (await api("/state")).body;
  const card = state.boxes.find(b => b.id === id);
  assert.ok(card.turnTs > 0, "turnTs was not stamped");
  assert.equal(card.ball, "you");
});

test("a note and a progress note never push", async () => {
  const noted = await create("A note does not push");
  assert.equal((await post(`/note?box=${noted}`, "still working")).status, 200);
  await noPushWithin(400);
  assert.equal((await api("/state")).body.boxes.find(b => b.id === noted).ball, "me");
  const id = await create("Progress does not push");
  assert.equal((await post(`/send?box=${id}`, "please go on")).status, 200);
  const claim = await api("/wait?owner=facilitator&timeout=2");
  assert.equal(claim.body.box, id);
  assert.equal((await post(`/ack?owner=facilitator&token=${claim.body.ack}`)).status, 200);
  assert.equal((await post(`/progress?box=${id}`, "half way")).status, 200);
  await noPushWithin(400);
  const before = pushes.length;
  assert.equal((await post(`/reply?box=${id}`, "done now")).status, 200);
  await pushesAfter(before + 1);
  assert.equal(pushes.length, before + 1);
});

test("a reply under a live working flag waits, and the flag dropping hands the turn over with one push", async () => {
  const id = await create("Deferred by the flag");
  assert.equal((await post(`/working?box=${id}&v=1`)).status, 200);
  assert.equal((await post(`/reply?box=${id}`, "answered mid work")).status, 200);
  await noPushWithin(400);
  let card = (await api("/state")).body.boxes.find(b => b.id === id);
  assert.equal(card.state, "working", "the reply under a flag did not stay green");
  const before = pushes.length;
  assert.equal((await post(`/working?box=${id}&v=0`)).status, 200);
  await pushesAfter(before + 1);
  assert.equal(pushes.length, before + 1);
  card = (await api("/state")).body.boxes.find(b => b.id === id);
  assert.equal(card.state, "yours");
  assert.ok(card.turnTs > 0);
});

test("a working flag expiring while a reply waits hands the turn over with one push", async () => {
  const id = await create("Deferred until expiry");
  assert.equal((await post(`/working?box=${id}&v=1`)).status, 200);
  assert.equal((await post(`/reply?box=${id}`, "answered, flag still beating")).status, 200);
  await noPushWithin(300);
  const before = pushes.length;
  await new Promise(resolve => setTimeout(resolve, 1100));   // past the patched one second clock
  const card = (await api("/state")).body.boxes.find(b => b.id === id);   // /state sweeps the clock
  assert.equal(card.state, "yours");
  await pushesAfter(before + 1);
  assert.equal(pushes.length, before + 1);
  const newest = (await api("/state")).body.boxes.filter(b => b.turnTs > 0).sort((a, b) => b.turnTs - a.turnTs)[0];
  assert.equal(newest.id, id, "the card that turned last does not carry the newest turnTs");
});

test("a subscription the push service reports gone is dropped", async () => {
  const gone = { endpoint: pushOrigin + "/gone/two", keys: { p256dh: "x", auth: "y" } };
  assert.equal((await post("/push/subscribe", JSON.stringify(gone))).body.count, 2);
  const id = await create("Push to a gone phone");
  const before = pushes.length;
  assert.equal((await post(`/reply?box=${id}`, "answer")).status, 200);
  await pushesAfter(before + 2);
  assert.deepEqual(pushes.slice(before).map(p => p.path).sort(), ["/gone/two", "/ok/one"]);
  const deadline = Date.now() + 3000;
  let subs;
  while (Date.now() < deadline) {
    subs = (await stateFile()).push_subs;
    if (subs.length === 1) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(subs.map(s => s.endpoint), [pushOrigin + "/ok/one"], "the gone subscription was kept");
});

// ---- what the log says about a push -------------------------------------------
// 245 of the 247 pushes in the live log read 403 and nothing else, because the
// body the service answers with, the one place it explains itself, was read
// and thrown away. These are about the line that replaces that one.

test("a service that refuses says why in its own words, cut and never dropped", async () => {
  const refusing = { endpoint: pushOrigin + "/refused/three", keys: { p256dh: "a", auth: "b" } };
  assert.equal((await post("/push/subscribe", JSON.stringify(refusing))).status, 200);
  const before = (await events()).filter(e => e.kind === "push").length;
  const id = await create("A push the service refuses");
  assert.equal((await post(`/reply?box=${id}`, "answered")).status, 200);

  const lines = await pushLines(before + 2);
  const refused = lines.filter(line => line.status === 403).at(-1);
  assert.ok(refused, "the refusal was not written down");
  assert.equal(refused.box, id);
  assert.equal(refused.host, new URL(pushOrigin).host);
  assert.equal(refused.level, "info");
  assert.equal(refused.reason.length, 200, "the service's words were not cut to two hundred");
  assert.equal(refused.reason, REFUSAL_BODY.slice(0, 200));
  assert.ok(REFUSAL_BODY.startsWith(refused.reason), "the words were mangled rather than cut");
});

test("a service that cannot be reached at all is written down as unreachable", async () => {
  const dead = `http://127.0.0.1:${await freePort()}/nobody/home`;
  assert.equal((await post("/push/subscribe", JSON.stringify({
    endpoint: dead, keys: { p256dh: "a", auth: "b" },
  }))).status, 200);
  const before = (await events()).filter(e => e.kind === "push").length;
  const id = await create("A push nobody answers");
  assert.equal((await post(`/reply?box=${id}`, "answered")).status, 200);

  const lines = await pushLines(before + 3, 8000);
  const missed = lines.filter(line => line.host === new URL(dead).host && !line.status).at(-1);
  assert.ok(missed, "an unreachable service wrote no line");
  assert.match(missed.reason, /^unreachable/);
});

test("a push that works is remembered, and the next start line names it", async () => {
  const deadline = Date.now() + 3000;
  let remembered;
  while (Date.now() < deadline) {
    remembered = (await stateFile()).push_last_ok;
    if (remembered) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(remembered, "a push that worked was not remembered");
  assert.equal(remembered.host, new URL(pushOrigin).host);
  assert.ok(remembered.ts > Date.now() / 1000 - 600, "the moment recorded is not this run's");

  await stopServer();
  await startServer();
  const started = (await events()).filter(event => event.kind === "start").at(-1);
  assert.equal(started.push_host, remembered.host);
  assert.equal(started.push_ok, remembered.ts);
});

test("no line anywhere carries a whole endpoint, only the service's host", async () => {
  const endpoints = (await stateFile()).push_subs.map(sub => sub.endpoint);
  assert.ok(endpoints.length > 0, "no subscription was stored, so this proves nothing");
  for (const event of await events()) {
    const line = JSON.stringify(event);
    for (const endpoint of endpoints.concat([pushOrigin + "/ok/one", pushOrigin + "/refused/three"])) {
      assert.ok(!line.includes(new URL(endpoint).pathname), `an endpoint reached the log: ${line}`);
    }
  }
});
