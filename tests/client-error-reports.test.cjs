// The route the pages report to. What a page noticed goes in its own file
// beside the server's, never in the transcript, and the caps here are what stop
// a page looping in a bug from filling the disk: a page's own counters die on
// reload, so only this cap is a cap. One fixture server on a free port; the
// suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let outer;
let fixtureDir;
let logs;
let origin;

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

async function linesOf(prefix) {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    if (!name.startsWith(prefix)) continue;
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(line);
    }
  }
  return out;
}

async function reports() {
  return (await linesOf("client-")).map(line => JSON.parse(line));
}

let readSoFar = 0;
async function reportsSince() {
  const all = await reports();
  const fresh = all.slice(readSoFar);
  readSoFar = all.length;
  return fresh;
}

async function send(batch, headers = {}) {
  const response = await fetch(origin + "/clientlog", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof batch === "string" ? batch : JSON.stringify(batch),
  });
  return { status: response.status, body: await response.json() };
}

function report(over = {}) {
  return {
    kind: "error", message: "Cannot read properties of null (reading 'reply')",
    file: "http://127.0.0.1/index.html", line: 7551, col: 12, count: 1, ...over,
  };
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-clientlog-"));
  fixtureDir = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(fixtureDir);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "client reports fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));

  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a board with nothing reported yet has no client file at all", async () => {
  assert.deepEqual((await readdir(logs)).filter(name => name.startsWith("client-")), []);
});

test("a well formed batch is stored one line per report, each of them JSON", async () => {
  const sent = await send({
    page: "board",
    reports: [
      report({ count: 3, box: "m12" }),
      report({ kind: "rejection", message: "TypeError: failed to fetch", line: 91 }),
      report({ kind: "slow", message: "the main thread was blocked", late: 3120, doing: "render" }),
    ],
  });
  assert.deepEqual(sent, { status: 200, body: { ok: true, written: 3, dropped: 0 } });

  const written = await reportsSince();
  assert.equal(written.length, 3);
  assert.deepEqual(written.map(line => line.kind), ["error", "rejection", "slow"]);
  for (const line of written) {
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(line.level, "info");
    assert.equal(line.page, "board");
  }
  assert.equal(written[0].box, "m12", "the report does not say which card was open");
  assert.equal(written[0].line, 7551);
  assert.equal(written[0].col, 12);
  assert.equal(written[0].count, 3, "how many times it happened was not kept");
  assert.equal(written[2].late, 3120);
  assert.equal(written[2].doing, "render");
  // and none of it went into the board's own file
  for (const line of await linesOf("server-")) {
    assert.ok(!line.includes("Cannot read properties"), "a page report reached the board's log");
  }
});

test("a batch this board cannot read is refused and nothing is stored", async () => {
  const before = (await reports()).length;
  for (const bad of [
    "not json at all",
    "",
    JSON.stringify({ reports: [report()] }),                       // no page
    JSON.stringify({ page: "desktop", reports: [report()] }),      // a page nobody serves
    JSON.stringify({ page: "board", reports: [] }),                // nothing in it
    JSON.stringify({ page: "board", reports: report() }),          // not a list
    JSON.stringify({ page: "board", reports: ["a thrown error"] }),
    JSON.stringify({ page: "board", reports: [report({ kind: "gossip" })] }),
    JSON.stringify([report()]),
  ]) {
    const refused = await send(bad);
    assert.equal(refused.status, 400, bad.slice(0, 40));
    assert.equal(refused.body.error, "bad report batch");
  }
  const many = { page: "board", reports: Array.from({ length: 21 }, (v, n) => report({ line: n })) };
  const overFull = await send(many);
  assert.equal(overFull.status, 400);
  assert.equal(overFull.body.error, "too many reports in one batch");
  assert.equal((await reports()).length, before, "a refused batch wrote something");
});

test("a body past the size limit is refused before it is even read", async () => {
  const before = (await reports()).length;
  const huge = JSON.stringify({
    page: "board",
    reports: [report({ message: "x".repeat(20 * 1024) })],
  });
  assert.ok(huge.length > 16 * 1024);
  const refused = await send(huge);
  assert.equal(refused.status, 413);
  assert.equal(refused.body.error, "report batch too large");
  assert.equal((await reports()).length, before);
});

test("a string longer than the cap is cut, and a field nobody asked for is dropped", async () => {
  await reportsSince();
  const sent = await send({
    page: "phone",
    reports: [report({
      message: "y".repeat(900),
      cardText: "the whole of a card's prose, which has no business being here",
      box: "m3",
    })],
  });
  assert.equal(sent.status, 200);
  const [line] = await reportsSince();
  assert.equal(line.message.length, 500, "a string past the cap was stored whole");
  assert.equal(line.message, "y".repeat(500));
  assert.equal(line.cardText, undefined, "a page wrote a field of its own choosing into the file");
});

test("forty reports of one key inside a minute store ten and say how many were dropped", async () => {
  await reportsSince();
  const looping = report({ message: "the same throw, over and over", line: 4242 });
  let written = 0;
  let dropped = 0;
  for (let batch = 0; batch < 4; batch++) {
    const sent = await send({ page: "board", reports: Array.from({ length: 10 }, () => looping) });
    assert.equal(sent.status, 200);
    written += sent.body.written;
    dropped += sent.body.dropped;
  }
  assert.equal(written, 10, "the cap did not hold");
  assert.equal(dropped, 30);

  const fresh = await reportsSince();
  assert.equal(fresh.filter(line => line.kind === "error").length, 10);
  const notices = fresh.filter(line => line.kind === "dropped");
  assert.ok(notices.length > 0, "the file is short and does not say so");
  assert.equal(notices.reduce((sum, line) => sum + line.dropped, 0), 30);
  assert.equal(notices[0].report, "error");
  assert.equal(notices[0].line, 4242);
});

test("two different keys are capped one by one, not together", async () => {
  await reportsSince();
  const first = report({ message: "one throw", line: 11 });
  const second = report({ message: "another throw entirely", line: 22 });
  for (let batch = 0; batch < 2; batch++) {
    const sent = await send({
      page: "board",
      reports: [...Array.from({ length: 8 }, () => first), ...Array.from({ length: 8 }, () => second)],
    });
    assert.equal(sent.status, 200);
  }
  const fresh = await reportsSince();
  assert.equal(fresh.filter(line => line.line === 11 && line.kind === "error").length, 10);
  assert.equal(fresh.filter(line => line.line === 22 && line.kind === "error").length, 10);
});

test("a report is stored whatever it says, and the board's own file still says nothing", async () => {
  const phrase = "chinchilla-obelisk-9042";
  await reportsSince();
  const sent = await send({
    page: "page",
    reports: [report({ message: `Cannot read the card holding ${phrase}`, line: 3 })],
  });
  assert.equal(sent.status, 200);
  const [line] = await reportsSince();
  assert.ok(line.message.includes(phrase), "the page's own words were not kept");
  for (const written of await linesOf("server-")) {
    assert.ok(!written.includes(phrase), `a page's words reached the board's log: ${written}`);
  }
});
