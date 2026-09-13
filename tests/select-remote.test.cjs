// The same flow with the board at a non-loopback address: notification,
// listing, selection, opening, the receipt and one attachment fetch. The point
// is that nothing in the protocol depends on the agent and the board sharing a
// machine, so none of it reads a board file from disk and every age comes from
// the board rather than from comparing two clocks.
//
// The shipped server binds loopback and this plan does not change that; where
// the board is reachable from is a deployment matter. The fixture patches its
// own copy to bind a network address, which is what makes the round trip
// testable without touching the shipped bind or the live board.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { createSocket } = require("node:dgram");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LANE = "facilitator";

let outer;
let app;
let port;
let host;
let origin;
let child;
let ids = 0;

const op = () => `remote-${String(++ids).padStart(6, "0")}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function routableAddress() {
  // the address this machine would use to reach somewhere else, found without
  // sending anything: a connected UDP socket only picks a route
  const probe = createSocket("udp4");
  try {
    await new Promise((resolve, reject) => probe.connect(9, "192.0.2.1", err => err ? reject(err) : resolve()));
    return probe.address().address;
  } finally {
    probe.close();
  }
}

async function freePort(bind) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, bind, resolve);
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

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  const type = response.headers.get("content-type") || "";
  return {
    status: response.status,
    type,
    body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()),
  };
}

const post = (route, body) => api(route, { method: "POST", body });

before(async () => {
  host = await routableAddress();
  assert.notEqual(host, "127.0.0.1", "no non-loopback address to test against");
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-remote-"));
  app = path.join(outer, "app");
  await mkdir(app);
  port = await freePort(host);
  origin = `http://${host}:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  // the one deployment fact this fixture changes, and the only one
  source = patch(source, 'sock.bind(("127.0.0.1", PORT))', 'sock.bind((os.environ["FACILITATOR_TEST_HOST"], PORT))');
  source = patch(source, 'build_app(), host="127.0.0.1", port=PORT,',
                 'build_app(), host=os.environ["FACILITATOR_TEST_HOST"], port=PORT,');
  await writeFile(path.join(app, "server.py"), source);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "remote fixture",
    items: [{ id: "m9", bucket: "work", title: "Shed roof felt", owner: LANE }],
  }));
  child = spawn("python3", [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_TEST_HOST: host,
           FACILITATOR_LOG_DIR: path.join(outer, "logs") },
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
    try {
      if ((await fetch(origin + "/state")).ok) break;
    } catch {}
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

test("the whole flow behaves the same over a network address", async () => {
  const timings = {};
  const clock = async (name, work) => {
    const started = Date.now();
    const out = await work();
    timings[name] = Date.now() - started;
    return out;
  };

  assert.equal((await post(`/hold?owner=${LANE}&session=s-far&agent=codex&machine=laptop`)).status, 200);

  // a one pixel png, invented for this test, attached to the card by name
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64");
  const uploaded = await api(`/upload?name=felt.png&box=m9`, { method: "POST", body: png });
  assert.equal(uploaded.status, 200);
  const file = uploaded.body.url.replace("/uploads/", "");

  assert.equal((await post(`/send?box=m9`, `the felt is lifting at the ridge, see /uploads/${file}`)).status, 200);

  // notification: counts and a notice id, and no card text
  const told = await clock("notify", () => api(`/notify?owner=${LANE}&session=s-far&agent=codex&timeout=10`));
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.equal(told.body.cards, 1);
  assert.equal(told.body.queued, 1);
  assert.equal(typeof told.body.notice, "string");
  assert.equal(typeof told.body.cursor, "string");
  assert.ok(!JSON.stringify(told.body).includes("lifting"), "the notification carried a message");

  assert.equal((await post(`/notified?owner=${LANE}&session=s-far&notice=${told.body.notice}&op=${op()}&adapter=monitor&outcome=accepted`)).status, 200);

  const listed = await clock("queue", () => api(`/queue?owner=${LANE}&session=s-far`));
  assert.equal(listed.status, 200);
  const row = listed.body.cards.find(c => c.box === "m9");
  assert.equal(row.attachments, 1, "the row did not count the attachment");
  assert.ok(!JSON.stringify(listed.body).includes("lifting"), "the listing carried a message");

  const chosen = await clock("select", () =>
    post(`/select?owner=${LANE}&session=s-far&box=m9&op=${op()}&row=${row.row}`));
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));

  const opened = await clock("open", () => post(`/open?owner=${LANE}&session=s-far&box=m9&op=${op()}`));
  assert.equal(opened.status, 200);
  const attachment = opened.body.messages[0].attachments[0];
  assert.equal(attachment.file, file);

  const receipt = await clock("opened", () =>
    post(`/opened?owner=${LANE}&session=s-far&delivery=${opened.body.delivery}&op=${op()}&route=tool`));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.route, "tool");

  // the attachment comes over the protocol, because an agent on another
  // machine cannot read the board's uploads folder
  const fetched = await clock("attachment", () => api(attachment.url));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.type, "image/png");
  assert.ok(fetched.body.equals(png), "the attachment did not come back byte for byte");

  // every age in the answers is the board's own, so nothing compares clocks
  assert.equal(typeof listed.body.now, "number");
  assert.equal(typeof listed.body.holder.idle_s, "number");
  console.log("remote round trip over", host, "ms:", JSON.stringify(timings));
});

test("an attachment for a card in another lane is not served", async () => {
  const wrong = await api(`/attachment?owner=pastureland&box=m9&file=whatever.png`);
  assert.equal(wrong.status, 404);
});

test("a reconnect carrying a cursor is not told again about what it has seen", async () => {
  const first = await api(`/notify?owner=${LANE}&session=s-far&timeout=3`);
  // the lane holds m9, so nothing else is waiting and the poll runs out idle
  assert.equal(first.status, 200);
  assert.equal(first.body.idle, true);
  assert.equal((await post(`/release?owner=${LANE}&session=s-far&box=m9&op=${op()}`)).status, 200);
  const told = await api(`/notify?owner=${LANE}&session=s-far&timeout=10`);
  assert.equal(told.body.cards, 1);
  // asking again with the cursor it just got does not mint a second notice for
  // the same work; asking with an older cursor gets that same notice back
  const behind = await api(`/notify?owner=${LANE}&session=s-far&timeout=3&cursor=c-0`);
  assert.equal(behind.body.notice, told.body.notice, "a second notice was minted for the same work");
  const current = await api(`/notify?owner=${LANE}&session=s-far&timeout=3&cursor=${told.body.cursor}`);
  assert.equal(current.body.idle, true, "the lane was told again about work it had already been told about");
});
