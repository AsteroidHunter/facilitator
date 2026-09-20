const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let fixtureDir;
let origin;

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

async function board() {
  const result = await api("/state");
  assert.equal(result.status, 200);
  return result.body;
}

async function create(title) {
  const result = await api("/create?owner=facilitator", { method: "POST", body: title });
  assert.equal(result.status, 200);
  return result.body.id;
}

async function transcriptFor(id) {
  const raw = await readFile(path.join(fixtureDir, "transcript.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map(JSON.parse).filter(event => event.box === id);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-done-close-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "authoritative close test",
    items: [
      {
        id: "reply-only", bucket: "meta", title: "Reply only",
        context: "A saved reply with no reply counter", owner: "facilitator",
      },
      {
        id: "static-empty", bucket: "now", title: "Empty fixed card",
        owner: "facilitator",
      },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
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
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("close deletes only a truly empty meta card and marks every other card done", async () => {
  let result = await api("/close?box=missing", { method: "POST" });
  assert.equal(result.status, 400);

  const emptyId = await create("Empty disposable card");
  result = await api(`/close?box=${emptyId}`, { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "deleted" } });
  assert.equal((await board()).boxes.some(box => box.id === emptyId), false);
  assert.deepEqual((await transcriptFor(emptyId)).map(event => event.kind), ["create", "delete"]);

  result = await api("/close?box=static-empty", { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "done" } });
  const fixed = (await board()).boxes.find(box => box.id === "static-empty");
  assert.equal(fixed.done, true, "an empty non-meta card was removed instead of completed");
  assert.deepEqual((await transcriptFor("static-empty")).map(event => event.kind), ["done"]);
});

test("legacy delete converts every form of nonempty meta card to done", async () => {
  let result = await api("/park?box=reply-only&v=1", { method: "POST" });
  assert.equal(result.status, 200);
  result = await api("/delete?box=reply-only", { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "done" } });

  const repliesOnly = await create("Reply count only");
  result = await api(`/reply?box=${repliesOnly}`, { method: "POST", body: "   " });
  assert.equal(result.status, 200);
  result = await api(`/delete?box=${repliesOnly}`, { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "done" } });

  const pendingOnly = await create("Pending only");
  result = await api(`/send?box=${pendingOnly}`, { method: "POST", body: "Do not lose this" });
  assert.equal(result.status, 200);
  result = await api(`/delete?box=${pendingOnly}`, { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "done" } });

  const state = await board();
  const protectedCards = [
    state.boxes.find(box => box.id === "reply-only"),
    state.boxes.find(box => box.id === repliesOnly),
    state.boxes.find(box => box.id === pendingOnly),
  ];
  assert.ok(protectedCards.every(box => box?.done && !box.parked),
    "a nonempty legacy delete did not retain the card as done");
  assert.equal(protectedCards[0].reply, "A saved reply with no reply counter");
  assert.equal(protectedCards[1].replies, 1);
  assert.equal(protectedCards[1].reply, "");
  assert.equal(protectedCards[2].pending, 1);

  for (const id of ["reply-only", repliesOnly, pendingOnly]) {
    const kinds = (await transcriptFor(id)).map(event => event.kind);
    assert.ok(kinds.includes("done"), `${id} did not log done`);
    assert.equal(kinds.includes("delete"), false, `${id} logged a destructive delete`);
  }

  const empty = await create("Legacy empty delete");
  result = await api(`/delete?box=${empty}`, { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "deleted" } });
  assert.equal((await board()).boxes.some(box => box.id === empty), false);
  assert.deepEqual((await transcriptFor(empty)).map(event => event.kind), ["create", "delete"]);
});

test("close classifies a reply that arrived after card creation from current server state", async () => {
  const id = await create("Fresh reply after birth");
  let result = await api(`/reply?box=${id}`, { method: "POST", body: "The reply arrived later" });
  assert.equal(result.status, 200);
  result = await api(`/close?box=${id}`, { method: "POST" });
  assert.deepEqual(result, { status: 200, body: { ok: true, action: "done" } });

  const saved = (await board()).boxes.find(box => box.id === id);
  assert.equal(saved.done, true);
  assert.equal(saved.reply, "The reply arrived later");
  assert.deepEqual((await transcriptFor(id)).map(event => event.kind),
    ["create", "agent", "done"]);
});

test("concurrent send and close serialize without deleting accepted content", async () => {
  for (let index = 0; index < 24; index += 1) {
    const id = await create(`Concurrent close ${index}`);
    const send = () => api(`/send?box=${id}`, {
      method: "POST", body: `Accepted message ${index}`,
    });
    const close = () => api(`/close?box=${id}`, { method: "POST" });
    const pair = index % 2 === 0
      ? await Promise.all([send(), close()])
      : (await Promise.all([close(), send()])).reverse();
    const [sent, closed] = pair;
    assert.equal(closed.status, 200);

    const saved = (await board()).boxes.find(box => box.id === id);
    const kinds = (await transcriptFor(id)).map(event => event.kind);
    if (sent.status === 200) {
      assert.ok(saved, "an accepted message's card was deleted");
      assert.equal(saved.done, true);
      assert.equal(saved.pending, 1);
      assert.ok(kinds.includes("user"));
      assert.ok(kinds.includes("done"));
      assert.equal(kinds.includes("delete"), false);
      assert.equal(closed.body.action, "done");
    } else {
      assert.equal(sent.status, 400, "the losing send did not report that close won");
      assert.equal(saved, undefined);
      assert.ok(kinds.includes("delete"));
      assert.equal(kinds.includes("user"), false, "a logged user message was deleted");
      assert.equal(closed.body.action, "deleted");
    }
  }
});

test("every browser close path delegates classification to close", async () => {
  for (const [name, expectedCloseCalls] of [["index.html", 3], ["page.html", 2]]) {
    const source = await readFile(path.join(ROOT, name), "utf8");
    assert.equal((source.match(/fetch\("\/close\?box="/g) || []).length, expectedCloseCalls,
      `${name} does not have exactly one /close call per close action`);
    assert.equal(source.includes("hasContent"), false,
      `${name} still classifies content from a render snapshot`);
    assert.equal(source.includes("/delete?box="), false,
      `${name} still exposes the destructive endpoint as a close action`);
    const doneCalls = source.match(/\/done\?box=/g) || [];
    assert.equal(doneCalls.length, 1, `${name} has a duplicated direct /done close path`);
    assert.match(source, /\/done\?box=.*&v=0/,
      `${name}'s only direct /done call is not the reopen action`);
  }
});
