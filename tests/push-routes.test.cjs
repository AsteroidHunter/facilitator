// The push side of the phone page, against a fixture server whose working
// flag expires in one second and a fake Tailscale CLI: the live bridge gate,
// public key, subscription store, VAPID token openssl signs (verified with
// openssl), and the exact events that send a push. Notes never push.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { createECDH, randomBytes } = require("node:crypto");
const { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } = require("node:fs/promises");
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
let bridgeOrigin;
let bridgeCookie;
let pushService;      // the stub push service the subscriptions point at
let pushOrigin;
const pushes = [];    // every push the stub received: {path, headers, body}
let binDir;
let tailscale;
let tailscaleMode;
let tailscaleStatus;
let serveStatus;
let pythonExecutable;
let dropBridgeWhenPushed = "";

const CONNECTED = { BackendState: "Running" };
const receiver = createECDH("prime256v1");
receiver.generateKeys();
const receiverKeys = {
  p256dh: b64url(receiver.getPublicKey()),
  auth: b64url(randomBytes(16)),
};

function servesBoard(targetPort = port + 1, mount = "/") {
  return {
    TCP: { "443": { HTTPS: true } },
    Web: {
      "fixture.tail0000.ts.net:443": {
        Handlers: { [mount]: { Proxy: `http://127.0.0.1:${targetPort}` } },
      },
    },
  };
}

async function setTailscale(status = CONNECTED, serve = servesBoard(), mode = "") {
  const encoded = value => typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(tailscaleStatus, encoded(status));
  await writeFile(serveStatus, encoded(serve));
  await writeFile(tailscaleMode, mode);
}

async function installFakeTailscale() {
  await writeFile(tailscale, [
    "#!/bin/bash",
    'mode="$(/bin/cat "$TS_MODE")"',
    'if [ "$1" = "status" ]; then',
    '  if [ "$mode" = "status-fail" ]; then echo "CLI_PRIVATE_SENTINEL" >&2; exit 23; fi',
    '  if [ "$mode" = "status-timeout" ]; then exec /bin/sleep 3; fi',
    '  if [ "$mode" = "status-bytes" ]; then printf "\\377"; exit 0; fi',
    '  /bin/cat "$TS_STATUS_JSON"; exit 0',
    "fi",
    'if [ "$1" = "serve" ] && [ "$2" = "status" ]; then',
    '  if [ "$mode" = "serve-fail" ]; then echo "CLI_PRIVATE_SENTINEL" >&2; exit 24; fi',
    '  if [ "$mode" = "serve-timeout" ]; then exec /bin/sleep 3; fi',
    '  if [ "$mode" = "serve-bytes" ]; then printf "\\377"; exit 0; fi',
    '  /bin/cat "$TS_SERVE_JSON"; exit 0',
    "fi",
    'echo "CLI_PRIVATE_SENTINEL" >&2; exit 25',
    "",
  ].join("\n"));
  await chmod(tailscale, 0o755);
}

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
  if (route.startsWith("/push/subscribe") || route.startsWith("/push/unsubscribe")) {
    const response = await fetch(bridgeOrigin + route, {
      method: "POST", body,
      headers: { Origin: bridgeOrigin, Cookie: bridgeCookie },
    });
    return { status: response.status, body: await response.json() };
  }
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

function decryptPush(push) {
  const script = [
    "import base64,json,sys,http_ece",
    "from cryptography.hazmat.primitives.asymmetric import ec",
    "dec=lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))",
    "private=ec.derive_private_key(int.from_bytes(dec(sys.argv[1])), ec.SECP256R1())",
    "plain=http_ece.decrypt(dec(sys.argv[3]), private_key=private, auth_secret=dec(sys.argv[2]), version='aes128gcm')",
    "print(plain.decode())",
  ].join(";");
  const plain = execFileSync(pythonExecutable, ["-c", script,
    b64url(receiver.getPrivateKey()), receiverKeys.auth, b64url(push.body)], { encoding: "utf8" });
  return JSON.parse(plain);
}

// the board itself, started and stopped: one test needs the start line the next
// boot writes, so the fixture has to be able to come back up
async function startServer() {
  child = spawn(pythonExecutable, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PATH: binDir,
      TS_MODE: tailscaleMode,
      TS_STATUS_JSON: tailscaleStatus,
      TS_SERVE_JSON: serveStatus,
      FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: logs,
    },
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

async function pushSkipsAfter(count, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const lines = (await events()).filter(event => event.kind === "pushskip");
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) throw new Error(`expected ${count} pushskip lines, saw ${lines.length}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function replyWithoutPush(title, expectedReason, responseWithin = null) {
  const beforePushes = pushes.length;
  const beforeSkips = (await events()).filter(event => event.kind === "pushskip").length;
  const id = await create(title);
  const started = Date.now();
  assert.equal((await post(`/reply?box=${id}`, "answered while unavailable")).status, 200);
  if (responseWithin !== null) {
    assert.ok(Date.now() - started < responseWithin, "the reply waited on the bridge check");
  }
  const skips = await pushSkipsAfter(beforeSkips + 1);
  assert.equal(pushes.length, beforePushes, "a push escaped the bridge gate");
  const skipped = skips.at(-1);
  assert.equal(skipped.box, id);
  assert.equal(skipped.reason, expectedReason);
  return id;
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-push-"));
  fixtureDir = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(fixtureDir);
  binDir = path.join(outer, "bin");
  await mkdir(binDir);
  pythonExecutable = process.env.FACILITATOR_TEST_PYTHON ||
    execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const openssl = execFileSync(pythonExecutable,
    ["-c", "import shutil; print(shutil.which('openssl') or '')"], { encoding: "utf8" }).trim();
  assert.ok(openssl, "openssl is unavailable");
  await symlink(openssl, path.join(binDir, "openssl"));
  tailscale = path.join(binDir, "tailscale");
  tailscaleMode = path.join(outer, "tailscale-mode");
  tailscaleStatus = path.join(outer, "tailscale-status.json");
  serveStatus = path.join(outer, "serve-status.json");
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  let patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  patched = patched.replace("BG_STALE = 75.0", "BG_STALE = 1.0");
  assert.match(patched, /BG_STALE = 1\.0/, "the working flag's clock was not patched");
  patched = patched.replace("PUSH_BRIDGE_TIMEOUT = 3.0", "PUSH_BRIDGE_TIMEOUT = 1.0");
  assert.match(patched, /PUSH_BRIDGE_TIMEOUT = 1\.0/, "the bridge timeout was not patched");
  patched = patched.replace(
    'TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
    'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"',
  );
  assert.match(patched, /TAILSCALE_APP = "\/facilitator-test\/no-tailscale-app"/,
    "the fixture could fall through to the real Mac app");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title: "push test", items: [] }));
  await installFakeTailscale();
  await setTailscale(CONNECTED, {});

  pushService = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => { chunks.push(chunk); });
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      pushes.push({ path: req.url, headers: req.headers, body });
      if (req.url === dropBridgeWhenPushed) {
        dropBridgeWhenPushed = "";
        await writeFile(serveStatus, "{}");
        res.statusCode = 410;
        res.end();
        return;
      }
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

  port = await require('./fixture-auth.cjs').freePortPair();
  origin = `http://127.0.0.1:${port}`;
  bridgeOrigin = `http://127.0.0.1:${port + 1}`;
  execFileSync(pythonExecutable, ["-c", "import bridge_auth; bridge_auth.set_password('FixturePush7!')"],
    { cwd: fixtureDir });
  await startServer();
  const login = await fetch(bridgeOrigin + "/auth/login", {
    method: "POST", headers: { Origin: bridgeOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "FixturePush7!" }),
  });
  assert.equal(login.status, 200);
  bridgeCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(bridgeCookie, "fixture login did not issue a bridge session");
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
  const sub = { endpoint: pushOrigin + "/ok/one", expirationTime: null, keys: receiverKeys };
  let result = await post("/push/subscribe", JSON.stringify(sub));
  assert.deepEqual(result, { status: 200, body: { ok: true, count: 1 } });
  result = await post("/push/subscribe", JSON.stringify(sub));
  assert.equal(result.body.count, 1, "the same endpoint was stored twice");
  const saved = (await stateFile()).push_subs;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].endpoint, sub.endpoint);
  assert.deepEqual(saved[0].keys, sub.keys);
});

test("pushes follow the live bridge without replaying turns missed while it was off", async () => {
  await setTailscale(CONNECTED, {});
  await replyWithoutPush("Bridge starts off", "bridge not serving this board");
  const subscribed = (await stateFile()).push_subs;
  assert.equal(subscribed.length, 1, "the bridge being off removed a subscription");

  await setTailscale(CONNECTED, servesBoard());
  await noPushWithin(200);
  const whileUp = await create("Bridge is up");
  const beforeUp = pushes.length;
  assert.equal((await post(`/reply?box=${whileUp}`, "this one should notify")).status, 200);
  await pushesAfter(beforeUp + 1);
  assert.equal(pushes.length, beforeUp + 1);

  await setTailscale(CONNECTED, {});
  await replyWithoutPush("Bridge switched off", "bridge not serving this board");
  assert.deepEqual((await stateFile()).push_subs, subscribed,
    "switching the bridge off changed the subscription");

  await setTailscale(CONNECTED, servesBoard());
  await noPushWithin(200);
});

test("an unrelated HTTPS Serve proxy does not open the push gate", async () => {
  const wrongPort = servesBoard(port);
  const wrongMount = servesBoard(port + 1, "/somewhere-else");
  const plainHTTP = servesBoard();
  plainHTTP.TCP["443"].HTTPS = false;
  const ipv6Loopback = servesBoard();
  ipv6Loopback.Web["fixture.tail0000.ts.net:443"].Handlers["/"].Proxy =
    `http://[::1]:${port + 1}`;
  for (const [name, config] of [
    ["A different service is shared", wrongPort],
    ["Only a different path is shared", wrongMount],
    ["The proxy is not HTTPS", plainHTTP],
    ["The proxy targets an address the board does not bind", ipv6Loopback],
  ]) {
    await setTailscale(CONNECTED, config);
    await replyWithoutPush(name, "bridge not serving this board");
  }
  await setTailscale(CONNECTED, servesBoard());
  await noPushWithin(200);
});

test("missing, disconnected, failed, timed out, and malformed bridge status all fail closed", async () => {
  const subscribed = (await stateFile()).push_subs;
  const cases = [
    ["disconnected backend", { BackendState: "Stopped" }, servesBoard(), "", "tailscale disconnected"],
    ["status command failure", CONNECTED, servesBoard(), "status-fail", "tailscale status unavailable"],
    ["status timeout", CONNECTED, servesBoard(), "status-timeout", "tailscale status unavailable", 600],
    ["invalid status bytes", CONNECTED, servesBoard(), "status-bytes", "tailscale status unavailable"],
    ["invalid status JSON", "not json", servesBoard(), "", "tailscale status unavailable"],
    ["null status JSON", null, servesBoard(), "", "tailscale status unavailable"],
    ["list status JSON", [], servesBoard(), "", "tailscale status unavailable"],
    ["wrong status field type", { BackendState: [] }, servesBoard(), "", "tailscale disconnected"],
    ["Serve command failure", CONNECTED, servesBoard(), "serve-fail", "serve status unavailable"],
    ["Serve timeout", CONNECTED, servesBoard(), "serve-timeout", "serve status unavailable", 600],
    ["invalid Serve bytes", CONNECTED, servesBoard(), "serve-bytes", "serve status unavailable"],
    ["invalid Serve JSON", CONNECTED, "not json", "", "serve status unavailable"],
    ["null Serve JSON", CONNECTED, null, "", "serve status unavailable"],
    ["list Serve JSON", CONNECTED, [], "", "serve status unavailable"],
    ["wrong Serve field types", CONNECTED, { TCP: [], Web: { "fixture:443": [] } }, "", "bridge not serving this board"],
    ["malformed Serve ports", CONNECTED, {
      TCP: { "443": { HTTPS: true } },
      Web: { "fixture:not-a-port": { Handlers: { "/": { Proxy: "http://127.0.0.1:not-a-port" } } } },
    }, "", "bridge not serving this board"],
  ];
  for (const [name, status, serve, mode, reason, responseWithin] of cases) {
    await setTailscale(status, serve, mode);
    await replyWithoutPush(name, reason, responseWithin);
  }

  await setTailscale(CONNECTED, servesBoard());
  const hidden = tailscale + ".off";
  await rename(tailscale, hidden);
  try {
    await replyWithoutPush("missing Tailscale command", "tailscale unavailable");
  } finally {
    await rename(hidden, tailscale);
  }

  const written = JSON.stringify(await events());
  assert.ok(!written.includes("CLI_PRIVATE_SENTINEL"), "private CLI output reached the log");
  assert.ok(!written.includes("fixture.tail0000.ts.net"), "the Serve machine name reached the log");
  assert.deepEqual((await stateFile()).push_subs, subscribed,
    "an unavailable or malformed bridge changed the subscriptions");
  await setTailscale(CONNECTED, servesBoard());
  await noPushWithin(200);
});

test("a plain reply sends one signed, encrypted push containing its card identity", async () => {
  const id = await create("Push on reply");
  const before = pushes.length;
  assert.equal((await post(`/reply?box=${id}`, "Here is the answer")).status, 200);
  await pushesAfter(before + 1);
  assert.equal(pushes.length, before + 1, "more than one push for one hand-over");
  const push = pushes[before];
  assert.equal(push.path, "/ok/one");
  assert.ok(push.body.length > 0, "the card payload was not sent");
  assert.equal(Number(push.headers["content-length"]), push.body.length);
  assert.equal(push.headers["content-encoding"], "aes128gcm");
  assert.deepEqual(decryptPush(push), { box: id, title: "Push on reply" });
  assert.ok(Number(push.headers.ttl) > 0, "no TTL header");
  await verifyVapid(push.headers.authorization, publicKey);
  const state = (await api("/state")).body;
  const card = state.boxes.find(b => b.id === id);
  assert.ok(card.turnTs > 0, "turnTs was not stamped");
  assert.equal(card.ball, "you");
});

test("two quick turns carry independent card ids and titles", async () => {
  const first = await create("First distinct notification");
  const second = await create("Second distinct notification");
  const before = pushes.length;
  assert.equal((await post(`/reply?box=${first}`, "first answer")).status, 200);
  assert.equal((await post(`/reply?box=${second}`, "second answer")).status, 200);
  await pushesAfter(before + 2);
  const payloads = pushes.slice(before, before + 2).map(decryptPush);
  assert.deepEqual(payloads.sort((a, b) => a.box.localeCompare(b.box)), [
    { box: first, title: "First distinct notification" },
    { box: second, title: "Second distinct notification" },
  ].sort((a, b) => a.box.localeCompare(b.box)));
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
  const gone = { endpoint: pushOrigin + "/gone/two", keys: receiverKeys };
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
  const refusing = { endpoint: pushOrigin + "/refused/three", keys: receiverKeys };
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
    endpoint: dead, keys: receiverKeys,
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
  remembered = (await stateFile()).push_last_ok;
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

test("a bridge drop between subscriptions stops the batch and keeps earlier results", async () => {
  await setTailscale(CONNECTED, servesBoard());
  const beforeState = await stateFile();
  assert.deepEqual(beforeState.push_subs.map(sub => new URL(sub.endpoint).pathname),
    ["/ok/one", "/refused/three", "/nobody/home"],
    "the fixture no longer has the order this transition test exercises");
  const beforePushes = pushes.length;
  const beforeSkips = (await events()).filter(event => event.kind === "pushskip").length;
  const beforeOK = beforeState.push_last_ok.ts;
  dropBridgeWhenPushed = "/refused/three";
  try {
    const id = await create("Bridge drops during a multi-phone turn");
    assert.equal((await post(`/reply?box=${id}`, "notify only while reachable")).status, 200);
    await pushesAfter(beforePushes + 2);
    const skips = await pushSkipsAfter(beforeSkips + 1);
    assert.equal(skips.at(-1).box, id);
    assert.equal(skips.at(-1).reason, "bridge not serving this board");
  } finally {
    dropBridgeWhenPushed = "";
  }
  assert.deepEqual(pushes.slice(beforePushes).map(push => push.path),
    ["/ok/one", "/refused/three"], "a subscription after the bridge drop was pushed");

  const deadline = Date.now() + 3000;
  let saved;
  while (Date.now() < deadline) {
    saved = await stateFile();
    if (saved.push_last_ok.ts > beforeOK &&
        !saved.push_subs.some(sub => new URL(sub.endpoint).pathname === "/refused/three")) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(saved.push_last_ok.ts > beforeOK, "the success before the bridge drop was forgotten");
  assert.equal(saved.push_last_ok.host, new URL(pushOrigin).host);
  assert.deepEqual(saved.push_subs.map(sub => new URL(sub.endpoint).pathname),
    ["/ok/one", "/nobody/home"], "the gone subscription before the bridge drop was kept");
  await setTailscale(CONNECTED, servesBoard());
});
