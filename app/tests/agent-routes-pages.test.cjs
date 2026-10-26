// /wait and /fresh claim a lane's card and hand over the messages waiting on
// it, so the board answers them to the lane's agent alone. No page of the
// board asks either. A board link in a card's text opened as a page (the fetch
// metadata says navigate, document and none) and a script on the board's own
// page (same-origin) are both refused with a 403 before anything is claimed or
// handed over: the card stays queued, nothing is held and its messages still
// wait. The same calls with no browser headers, as curl and the scripts send
// them, claim and fetch as ever. One fixture board on a free pair of ports; the
// suite never touches 8877. Every card and message is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { request } = require("node:http");
const { readFile, readdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const SEED = { title: "agent routes board", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
  { id: "4", bucket: "now", title: "Card a link in another card points at", owner: "pastureland" },
] };
const REFUSED = { error: "only the lane's agent asks this" };

let board;
// what Chrome sends for a board link opened as a page, and for a script on the
// board's own page; the Origin is filled in once the port is known
const OPENED = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1" };
const SCRIPT = { Origin: "", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
const PAGES = [["a board link opened as a page", OPENED], ["a script on the board's own page", SCRIPT]];

before(async () => {
  // these cases are about who may ask, not the typing hold (typing-hold.test.cjs),
  // so a card is free to go out the moment a message lands, and a refusal that
  // claims nothing proves something
  board = await startBoard({ seed: SEED, prepare: async ({ app }) => {
    const file = path.join(app, "server.py");
    const source = await readFile(file, "utf8");
    const patched = source.replace("TYPING_HOLD = 3.5", "TYPING_HOLD = 0.0");
    assert.notEqual(patched, source, "test server typing hold was not patched");
    await writeFile(file, patched);
  } });
  SCRIPT.Origin = board.origin;
});
after(async () => { if (board) await board.stop(); });

// one GET on the board's own port with exactly these headers and no others
function get(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: board.port, method: "GET", path: route,
      headers: { Host: `127.0.0.1:${board.port}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: JSON.parse(text) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
// the agent's own writes, with no browser headers
async function agentPost(route, body = "") {
  const response = await fetch(board.origin + route, { method: "POST", body });
  assert.equal(response.status, 200, route);
  return response.json();
}
const saved = () => readFile(path.join(board.data, "state.json"), "utf8");
async function card() {
  const state = JSON.parse(await saved());
  return { box: state.boxes.find(b => b.id === "4"), busy: state.busy.pastureland || null,
    claimed: state.claimed.pastureland || [] };
}
async function refusals() {
  const out = [];
  for (const name of (await readdir(board.logs)).sort())
    for (const line of (await readFile(path.join(board.logs, name), "utf8")).split("\n"))
      if (line !== "") {
        const event = JSON.parse(line);
        if (event.kind === "refusal") out.push(event);
      }
  return out;
}

test("a page's /wait claims nothing: the card stays queued with its messages waiting", async () => {
  assert.equal((await board.say("4", "an invented first message on the card")).status, 200);
  const before = await saved();
  const linesBefore = (await refusals()).length;
  for (const [name, headers] of PAGES) {
    const started = Date.now();
    const said = await get("/wait?owner=pastureland&timeout=30&agent=claude", headers);
    assert.equal(said.status, 403, name);
    assert.deepEqual(said.body, REFUSED, name);
    assert.ok(Date.now() - started < 5000, `${name}: the refusal sat in a listener's seat`);
  }
  assert.equal(await saved(), before, "a page's /wait changed the board");
  const { box, busy, claimed } = await card();
  assert.equal(box.state, "queued");
  assert.equal(busy, null, "a page's /wait left the card held");
  assert.deepEqual(claimed, []);
  assert.deepEqual(box.pending.map(m => m.text), ["an invented first message on the card"]);
  assert.deepEqual((await get("/unread?owner=pastureland")).body, { queued: 1, claimed: 0 });
  // each refusal written down once, like every other
  const lines = (await refusals()).slice(linesBefore);
  assert.deepEqual(lines.map(line => [line.route, line.code, line.reason]),
    PAGES.map(() => ["/wait", 403, REFUSED.error]));

  // the agent, with no browser headers, claims it as ever
  const handed = await get("/wait?owner=pastureland&timeout=5&agent=claude");
  assert.equal(handed.status, 200);
  assert.equal(handed.body.box, "4");
  assert.deepEqual(handed.body.messages, ["an invented first message on the card"]);
  await agentPost(`/ack?owner=pastureland&token=${handed.body.ack}`);
  assert.equal((await card()).busy, "4");
});

test("a page's /fresh hands nothing over: the message stays waiting for the agent that holds the card", async () => {
  assert.equal((await board.say("4", "an invented message sent while the agent works")).status, 200);
  const before = await saved();
  const linesBefore = (await refusals()).length;
  for (const [name, headers] of PAGES) {
    const said = await get("/fresh?owner=pastureland", headers);
    assert.equal(said.status, 403, name);
    assert.deepEqual(said.body, REFUSED, name);
  }
  assert.equal(await saved(), before, "a page's /fresh changed the board");
  const { box, busy, claimed } = await card();
  assert.equal(busy, "4", "the agent's claim was let go");
  assert.equal(claimed.length, 1, "the waiting message was folded into the claim");
  assert.equal(box.pending.length, 2);
  assert.deepEqual((await get("/unread?owner=pastureland")).body, { queued: 1, claimed: 1 });
  const lines = (await refusals()).slice(linesBefore);
  assert.deepEqual(lines.map(line => [line.route, line.code, line.reason]),
    PAGES.map(() => ["/fresh", 403, REFUSED.error]));

  // the agent's own /fresh hands it over, and its answer covers both
  const fresh = await get("/fresh?owner=pastureland");
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.messages, ["an invented message sent while the agent works"]);
  assert.deepEqual((await get("/unread?owner=pastureland")).body, { queued: 0, claimed: 2 });
  await agentPost("/reply?box=4", "an invented answer from the lane's agent");
  assert.deepEqual((await card()).box.pending, []);
});

test("/unread stays open to a page: it only reads", async () => {
  const agents = (await get("/unread?owner=pastureland")).body;
  for (const [name, headers] of PAGES) {
    const said = await get("/unread?owner=pastureland", headers);
    assert.equal(said.status, 200, name);
    assert.deepEqual(said.body, agents, name);
  }
});
