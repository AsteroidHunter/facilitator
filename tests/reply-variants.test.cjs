const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
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

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  const contentType = response.headers.get("content-type") || "";
  return {
    status: response.status,
    contentType,
    body: contentType.includes("json") ? await response.json() : await response.text(),
  };
}

async function startServer() {
  serverOutput = "";
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
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

function box(board, id = "m1") {
  return board.boxes.find(item => item.id === id);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-reply-variants-"));
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  await copyFile(path.join(ROOT, "card-markdown.js"), path.join(fixtureDir, "card-markdown.js"));
  await copyFile(path.join(ROOT, "card-tokens.css"), path.join(fixtureDir, "card-tokens.css"));
  await copyFile(path.join(ROOT, "card-logic.js"), path.join(fixtureDir, "card-logic.js"));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "reply variants",
    items: [{
      id: "m1", bucket: "meta", title: "Variants", owner: "facilitator",
      context: "Fresh seed\n\n---\n\nStill authored text",
    }],
  }));
  await writeFile(path.join(fixtureDir, "transcript.jsonl"), [
    JSON.stringify({ ts: 9999999999999, kind: "agent", box: "m1", text: "Future compact\n---\nFuture full" }),
    JSON.stringify({ ts: 123, kind: "agent", box: "m1", text: "Equal compact one\n---\nEqual full one" }),
    JSON.stringify({ ts: 123, kind: "agent", box: "m1", text: "Equal compact two\n---\nEqual full two" }),
    JSON.stringify({ kind: "agent", box: "m1", text: "Missing compact\n---\nMissing full" }),
    JSON.stringify({ ts: "not-a-time", kind: "agent", box: "m1", text: "Malformed compact\n---\nMalformed full" }),
    JSON.stringify({ ts: 124, kind: "user", box: "m1", text: "Old question" }),
  ].join("\n") + "\n");
  await startServer();
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("reply migration distinguishes explicit state and uses one durable transcript boundary", async () => {
  let state = await api("/state");
  assert.equal(state.status, 200);
  const freshText = "Fresh seed\n\n---\n\nStill authored text";
  assert.equal(box(state.body).reply, freshText);
  assert.equal(box(state.body).replyFull, freshText);
  assert.equal(box(state.body).replyShort, freshText,
    "fresh explicit seed data was mistaken for a legacy reply");

  let saved = JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
  assert.equal(saved.reply_variants_version, 1);
  assert.equal(saved.transcript_reply_variants_version, 1);
  assert.equal("reply_variants_migrated_at" in saved, false);

  // These old-shaped rows are physically after the schema marker. Their
  // timestamps repeat every hostile shape above, but none may be legacy-split.
  await appendFile(path.join(fixtureDir, "transcript.jsonl"), [
    JSON.stringify({ ts: 9999999999999, kind: "agent", box: "m1", text: "Post future\n---\nKept future" }),
    JSON.stringify({ ts: 123, kind: "agent", box: "m1", text: "Post equal\n---\nKept equal" }),
    JSON.stringify({ kind: "agent", box: "m1", text: "Post missing\n---\nKept missing" }),
    JSON.stringify({ ts: "not-a-time", kind: "agent", box: "m1", text: "Post malformed\n---\nKept malformed" }),
  ].join("\n") + "\n");

  const firstThread = await api("/thread?box=m1&n=30");
  const before = firstThread.body.messages.slice(0, 5);
  assert.deepEqual(before.map(message => [message.replyShort, message.replyFull]), [
    ["Future compact", "Future full"],
    ["Equal compact one", "Equal full one"],
    ["Equal compact two", "Equal full two"],
    ["Missing compact", "Missing full"],
    ["Malformed compact", "Malformed full"],
  ]);
  const afterBoundary = firstThread.body.messages.slice(-4);
  assert.ok(afterBoundary.every(message =>
    message.replyShort === message.text && message.replyFull === message.text),
  "a post-boundary row was split by its timestamp");
  assert.deepEqual((await api("/thread?box=m1&n=30")).body, firstThread.body,
    "repeated reads changed the compatibility result");

  // Recreate the two state shapes the top-level marker cannot distinguish:
  // one box already has explicit fields, and one is genuinely legacy.
  await stopServer();
  saved = JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
  delete saved.reply_variants_version;
  saved.reply_variants_migrated_at = 123;
  const explicit = saved.boxes.find(item => item.id === "m1");
  explicit.reply = "conflicting legacy shim";
  explicit.reply_full = "Explicit full\n---\nkept";
  explicit.reply_short = "Explicit short";
  const legacy = saved.boxes.find(item => item.id === "t0");
  legacy.reply = "Legacy compact\n---\nLegacy full";
  delete legacy.reply_full;
  delete legacy.reply_short;
  await writeFile(path.join(fixtureDir, "state.json"), JSON.stringify(saved, null, 1));
  await startServer();

  state = await api("/state");
  assert.equal(box(state.body).replyFull, "Explicit full\n---\nkept");
  assert.equal(box(state.body).replyShort, "Explicit short");
  assert.equal(box(state.body, "t0").replyFull, "Legacy full");
  assert.equal(box(state.body, "t0").replyShort, "Legacy compact");

  // Two complete restarts prove explicit full text is never parsed again.
  for (let restart = 0; restart < 2; restart++) {
    await stopServer();
    await startServer();
    state = await api("/state");
    assert.equal(box(state.body).replyFull, "Explicit full\n---\nkept");
    assert.equal(box(state.body).replyShort, "Explicit short");
    assert.equal(box(state.body, "t0").replyFull, "Legacy full");
    assert.equal(box(state.body, "t0").replyShort, "Legacy compact");
  }
  assert.deepEqual((await api("/thread?box=m1&n=30")).body, firstThread.body,
    "restart moved the transcript schema boundary");

  const rows = (await readFile(path.join(fixtureDir, "transcript.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const markers = rows.filter(row => row.kind === "schema" &&
    row.schema === "reply_variants" && row.version === 1);
  assert.equal(markers.length, 1, "migration appended more than one schema boundary");
});

test("new explicit variants keep authored horizontal rules in full text", async () => {
  const full = "Before\n\n---\n\nAfter";
  let result = await api("/reply?box=m1&short=Compact%20answer", {
    method: "POST", body: full,
  });
  assert.equal(result.status, 200);
  let state = await api("/state");
  assert.equal(box(state.body).replyFull, full);
  assert.equal(box(state.body).replyShort, "Compact answer");

  const thread = await api("/thread?box=m1&n=10");
  const newest = thread.body.messages.at(-1);
  assert.equal(newest.text, full);
  assert.equal(newest.replyFull, full);
  assert.equal(newest.replyShort, "Compact answer");

  result = await api("/reply?box=m1", { method: "POST", body: "A\n---\nB" });
  assert.equal(result.status, 200);
  state = await api("/state");
  assert.equal(box(state.body).replyFull, "A\n---\nB");
  assert.equal(box(state.body).replyShort, "A\n---\nB");

  await stopServer();
  await startServer();
  state = await api("/state");
  assert.equal(box(state.body).replyFull, "A\n---\nB");
  assert.equal(box(state.body).replyShort, "A\n---\nB",
    "versioned state was parsed as legacy data on restart");
});

test("small-card cap measures the explicit compact variant", async () => {
  let result = await api("/send?box=m1&via=mini", { method: "POST", body: "Mini question" });
  assert.equal(result.status, 200);
  const delivery = await api("/wait?owner=facilitator&timeout=1&agent=test");
  assert.equal(delivery.body.box, "m1");
  result = await api(`/ack?owner=facilitator&token=${delivery.body.ack}`, { method: "POST" });
  assert.equal(result.status, 200);
  const longFull = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
  result = await api("/reply?box=m1&short=Brief%20result", { method: "POST", body: longFull });
  assert.equal(result.status, 200);
  const state = await api("/state");
  assert.equal(box(state.body).replyFull, longFull);
  assert.equal(box(state.body).replyShort, "Brief result");
});

test("real server exposes the shared renderer", async () => {
  const result = await api("/card-markdown.js");
  assert.equal(result.status, 200);
  assert.match(result.contentType, /application\/javascript/);
  assert.match(result.body, /safeImageTarget/);
});

test("real server serves the shared card files and both pages load them", async () => {
  for (const [route, type, mark] of [
    ["/card-tokens.css", /^text\/css/, /\.cardmd\{overflow-wrap:anywhere\}/],
    ["/card-logic.js", /^application\/javascript/, /function cardState\(b\)\{/],
  ]) {
    const result = await api(route);
    assert.equal(result.status, 200, route);
    assert.match(result.contentType, type, route);
    assert.match(result.body, mark, route);
  }
  for (const name of ["index.html", "m.html"]) {
    const source = await readFile(path.join(ROOT, name), "utf8");
    assert.match(source, /<link rel="stylesheet" href="\/card-tokens\.css">/, `${name} does not load card-tokens.css`);
    assert.match(source, /<script src="\/card-markdown\.js"><\/script>\n<script src="\/card-logic\.js"><\/script>/,
      `${name} does not load card-logic.js right after card-markdown.js`);
  }
});
