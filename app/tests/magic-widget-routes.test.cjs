// A widget in a card's magic box through the real routes: an html page named
// with widget= talks with the board, the person's messages typed in it reach
// the card's agent in /wait and /fresh as widget_messages and never on the
// card, the agent answers into the widget and its claim is let go, and the
// widget's record and memory outlast a new page and a restart. A board page
// (Origin and Sec-Fetch-Site, as a browser sends them) may send and save and
// may not answer; an agent (neither header, as curl and the command send) may
// answer and may not send; the phone's port refuses the answer route. No
// browser is started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { readFile, readdir } = require("node:fs/promises");
const { request } = require("node:http");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PASS = "widget-fixture-pass-7";
const SEED = { title: "widget fixture", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
] };
const PAGE = "<!doctype html><p>a widget</p><script>facilitator.ready()</script>";
let board;

before(async () => {
  board = await startBoard({ seed: SEED, prepare: ({ app }) => {
    execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
  } });
});
after(async () => { if (board) await board.stop(); });

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const parse = r => { try { return { status: r.status, body: JSON.parse(r.text) }; } catch { return { status: r.status, body: r.text }; } };
// the board's own page, as Chrome sends its requests
const page = async (method, route, body) => parse(await board.call(method, route, body));
// an agent: curl, onboard.py and the facilitator command send no Origin and no Sec-Fetch-Site
const agent = async (method, route, body) => {
  const r = await fetch(board.origin + route, { method, body });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const state = async () => (await fetch(board.origin + "/state")).json();
const card = async id => (await state()).boxes.find(b => b.id === id);
const fill = async (id, extra = "&widget=issues", body = PAGE) => agent("POST", `/magic?box=${id}&kind=html${extra}`, body);
const rows = async kind => (await readFile(path.join(board.data, "transcript.jsonl"), "utf8")).trim().split("\n")
  .map(line => JSON.parse(line)).filter(e => e.kind === kind);
const record = async id => (await agent("GET", `/magic/widget?box=${id}`)).body;
let ops = 0;
const op = () => "widgetop" + String(++ops).padStart(4, "0");
// the person's message typed in the widget, as the board's page passes it on
async function send(id, text, about, extra = "") {
  const rev = (await card(id)).magic.rev;
  return page("POST", `/magic/send?box=${id}&rev=${rev}&op=${op()}${extra}`, JSON.stringify({ text, about }));
}
// what the card itself shows: its messages, its reply and its thread
async function ownHistory(id) {
  const c = await card(id);
  const thread = (await agent("GET", `/thread?box=${id}`)).body;
  return { pending: c.pendingTexts, reply: c.reply, replies: c.replies, answered: c.answered, thread };
}
async function claim() {
  const r = await agent("GET", "/wait?owner=facilitator&timeout=12&agent=opus");
  assert.equal(r.status, 200);
  if (r.body.ack) assert.equal((await agent("POST", `/ack?owner=facilitator&token=${r.body.ack}`)).status, 200);
  return r.body;
}

test("only an html page named with widget= is a widget, and other boxes read as they always did", async () => {
  let r = await fill("0");
  assert.equal(r.status, 200);
  assert.equal(r.body.widget, "issues");
  const magic = (await card("0")).magic;
  assert.deepEqual(Object.keys(magic).sort(), ["kind", "open", "rev", "ts", "widget", "wrev"]);
  assert.equal(magic.wrev, 0);
  assert.equal((await agent("GET", "/magic?box=0")).body.widget, "issues");
  assert.equal((await agent("GET", "/magic/body?box=0")).body.widget, "issues");
  assert.deepEqual(await record("0"), { box: "0", widget: "issues", rev: magic.rev, wrev: 0, thread: [], trev: 0, state: null, srev: 0 });
  for (const [extra, words] of [["&widget=Bad_Name", /widget's name/], ["&widget=" + "a".repeat(41), /widget's name/]])
    assert.match((await fill("0", extra)).body.error, words);
  assert.match((await agent("POST", "/magic?box=0&kind=text&widget=issues", "words")).body.error, /only an html page/);
  // a plain page and a text box are no widget: nothing reaches their agent
  const other = (await agent("POST", "/create?owner=facilitator", "plain boxes")).body.id;
  for (const [kind, body] of [["html", "<p>a mock</p>"], ["text", "words"]]) {
    await agent("POST", `/magic?box=${other}&kind=${kind}`, body);
    assert.deepEqual(Object.keys((await card(other)).magic).sort(), ["kind", "open", "rev", "ts"]);
    assert.equal((await send(other, "hello", "")).status, 404, kind);
    assert.equal((await agent("GET", `/magic/widget?box=${other}`)).status, 404);
    assert.equal((await agent("POST", `/magic/answer?box=${other}&about=x`, "an answer")).status, 404);
  }
  assert.equal((await agent("POST", `/close?box=${other}`)).status, 200);
});

test("the person's message reaches the agent beside the card's messages, marked, and never lands on the card", async () => {
  await fill("0");
  const before = await ownHistory("0");
  // an agent cannot send for the widget, the page can
  assert.equal((await agent("POST", `/magic/send?box=0&rev=${(await card("0")).magic.rev}`, JSON.stringify({ text: "x" }))).status, 403);
  const sent = await send("0", "Is this still needed?", "t12-login");
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(Object.keys(sent.body).sort(), ["box", "id", "ok"]);
  assert.deepEqual(await ownHistory("0"), before, "the message landed on the card");
  assert.equal((await card("0")).magic.wrev, 1);
  assert.deepEqual(await agent("GET", "/unread?owner=facilitator").then(r => r.body), { queued: 1, claimed: 0 });
  const [row] = await rows("widget");
  assert.deepEqual({ box: row.box, text: row.text, widget: row.widget, about: row.about },
    { box: "0", text: "Is this still needed?", widget: "issues", about: "t12-login" });
  // the typing hold applies, as it does to a message on the card
  const asked = Date.now();
  const got = await claim();
  assert.ok(Date.now() - asked > 2500, "the card went out inside the typing hold");
  assert.equal(got.box, "0");
  assert.deepEqual(got.messages, []);
  assert.deepEqual(got.widget_messages.map(({ ts, ...m }) => m),
    [{ from: "widget", widget: "issues", about: "t12-login", text: "Is this still needed?" }]);
  assert.ok(got.widget_messages[0].ts > 0);
  // nothing new: /fresh reads exactly as it always did
  assert.deepEqual((await agent("GET", "/fresh?owner=facilitator")).body,
    { box: "0", messages: [], message_via: [], message_by: [], message_agent: [] });
  // a second message mid-work comes from /fresh, once the hold has run out
  await pause(1100);
  assert.equal((await send("0", "And on the phone?", "t12-login")).status, 200);
  assert.equal((await agent("GET", "/fresh?owner=facilitator")).body.widget_messages, undefined, "handed over inside the hold");
  await pause(3700);
  const fresh = (await agent("GET", "/fresh?owner=facilitator")).body;
  assert.deepEqual(fresh.widget_messages.map(m => m.text), ["And on the phone?"]);
  assert.deepEqual(fresh.messages, []);
  assert.deepEqual(await agent("GET", "/unread?owner=facilitator").then(r => r.body), { queued: 0, claimed: 2 });
  // a page cannot answer for the agent; an answer about another id answers nothing
  assert.equal((await page("POST", "/magic/answer?box=0&about=t12-login", "forged")).status, 403);
  let answer = await agent("POST", "/magic/answer?box=0&about=t13-other&agent=opus", "Not this one.");
  assert.deepEqual([answer.body.answered, answer.body.released], [0, false]);
  answer = await agent("POST", "/magic/answer?box=0&about=t12-login&agent=opus", "Yes, and the phone too.");
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.body.answered, answer.body.released], [2, true]);
  assert.deepEqual(await agent("GET", "/unread?owner=facilitator").then(r => r.body), { queued: 0, claimed: 0 });
  assert.deepEqual(await ownHistory("0"), before, "the answer landed on the card");
  const rec = await record("0");
  assert.deepEqual(rec.thread.map(({ ts, ...m }) => m), [
    { id: 1, by: "you", about: "t12-login", text: "Is this still needed?" },
    { id: 2, by: "you", about: "t12-login", text: "And on the phone?" },
    { id: 3, by: "agent", about: "t13-other", text: "Not this one.", agent: "opus" },
    { id: 4, by: "agent", about: "t12-login", text: "Yes, and the phone too.", agent: "opus" },
  ]);
  assert.deepEqual((await rows("widget_answer")).map(e => [e.about, e.text, e.answered]),
    [["t13-other", "Not this one.", 0], ["t12-login", "Yes, and the phone too.", 2]]);
  assert.equal((await agent("GET", "/wait?owner=facilitator&timeout=1")).body.idle, true, "the card was handed out again");
});

test("a reply on the card still works, and takes the widget messages its claim held", async () => {
  await fill("0");
  await pause(1100);
  assert.equal((await send("0", "About the widget", "t1")).status, 200);
  assert.equal((await page("POST", "/send?box=0", "And a word on the card")).status, 200);
  let got = await claim();
  assert.deepEqual(got.messages, ["And a word on the card"]);
  assert.deepEqual(got.widget_messages.map(m => m.text), ["About the widget"]);
  // the widget's part answered, the card's message still held
  const answer = await agent("POST", "/magic/answer?box=0&about=t1", "Answered in the widget.");
  assert.deepEqual([answer.body.answered, answer.body.released], [1, false]);
  assert.equal((await agent("POST", "/reply?box=0", "Answered on the card.")).status, 200);
  assert.equal((await card("0")).reply, "Answered on the card.");
  assert.deepEqual(await agent("GET", "/unread?owner=facilitator").then(r => r.body), { queued: 0, claimed: 0 });
  // a widget message answered by a reply alone is not handed out again
  await pause(1100);
  assert.equal((await send("0", "Only in the widget", "t2")).status, 200);
  got = await claim();
  assert.deepEqual([got.messages, got.widget_messages.length], [[], 1]);
  assert.equal((await agent("POST", "/reply?box=0", "A reply on the card.")).status, 200);
  assert.deepEqual(await agent("GET", "/unread?owner=facilitator").then(r => r.body), { queued: 0, claimed: 0 });
  assert.equal((await agent("GET", "/wait?owner=facilitator&timeout=1")).body.idle, true);
});

test("the widget's messages, answers and memory outlast a new page of its name and a restart; another name starts empty", async () => {
  await fill("0");
  const rev = (await card("0")).magic.rev;
  assert.equal((await agent("POST", `/magic/state?box=0&rev=${rev}`, JSON.stringify({ state: { shown: "t5" } }))).status, 403);
  let saved = await page("POST", `/magic/state?box=0&rev=${rev}`, JSON.stringify({ state: { shown: "t5" } }));
  assert.equal(saved.status, 200);
  const big = JSON.stringify({ state: { blob: "x".repeat(65 * 1024) } });
  assert.equal((await page("POST", `/magic/state?box=0&rev=${rev}`, big)).status, 413);
  assert.equal((await page("POST", `/magic/state?box=0&rev=${rev}`, JSON.stringify({ state: [1] }))).status, 400);
  assert.equal((await page("POST", `/magic/state?box=0&rev=${rev - 1}`, JSON.stringify({ state: {} }))).status, 409);
  const wrev = (await card("0")).magic.wrev;
  assert.equal(wrev > 0, true);
  const kept = await record("0");
  assert.deepEqual(kept.state, { shown: "t5" });
  // a new page of the same name, then a restart
  await fill("0");
  let now = await record("0");
  assert.deepEqual([now.thread, now.state, now.srev], [kept.thread, kept.state, kept.srev]);
  assert.equal((await card("0")).magic.wrev, wrev, "the record's revision went back with a new page");
  await board.restart();
  now = await record("0");
  assert.deepEqual([now.thread, now.state], [kept.thread, kept.state]);
  // another widget's name starts empty, and the first comes back with its name
  await fill("0", "&widget=other");
  now = await record("0");
  assert.deepEqual([now.widget, now.thread, now.state], ["other", [], null]);
  await fill("0");
  assert.deepEqual((await record("0")).thread, kept.thread);
  const names = (await readdir(path.join(board.data, "magic-boxes"))).filter(n => !n.startsWith(".")).sort();
  // the box's older revisions go, the widget's record stays; a widget nothing
  // was said or kept in has no file
  assert.deepEqual(names, [`0-${(await card("0")).magic.rev}.json`, "0@issues.widget.json"]);
});

test("a page's message is refused when it is too fast, from a replaced page, or not one message", async () => {
  await fill("0");
  await pause(1100);
  assert.equal((await send("0", "first", "t1")).status, 200);
  assert.equal((await send("0", "too soon", "t1")).status, 429);
  await pause(1100);
  const rev = (await card("0")).magic.rev;
  const post = (body, extra = `&rev=${rev}`) => page("POST", `/magic/send?box=0${extra}&op=${op()}`, body);
  assert.equal((await post(JSON.stringify({ text: "old page", about: "t1" }), `&rev=${rev - 1}`)).status, 409);
  for (const body of ["not json", JSON.stringify([1]), JSON.stringify({ text: "   " }), JSON.stringify({ text: "x".repeat(8001) }),
    JSON.stringify({ text: "spaced id", about: "t 1" }), JSON.stringify({ text: "long id", about: "t".repeat(65) })])
    assert.equal((await post(body)).status, 400, body.slice(0, 40));
  // a retry under one operation id lands once; the id with other words is refused
  const id = op(), route = `/magic/send?box=0&rev=${rev}&op=${id}`;
  const first = await page("POST", route, JSON.stringify({ text: "once", about: "t1" }));
  const again = await page("POST", route, JSON.stringify({ text: "once", about: "t1" }));
  assert.deepEqual([first.status, again.status, again.body.replayed, again.body.id], [200, 200, true, first.body.id]);
  assert.equal((await page("POST", route, JSON.stringify({ text: "other words", about: "t1" }))).status, 409);
  assert.equal((await record("0")).thread.filter(m => m.text === "once").length, 1);
  // the claim this left is answered, so the lane is clear
  await claim();
  await agent("POST", "/magic/answer?box=0&about=t1", "Done.");
});

test("the phone may read a widget and send in it, and never reaches the answer route", async () => {
  await fill("0");
  const bridge = board.port + 1, origin = `http://127.0.0.1:${bridge}`;
  const call = (method, route, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: bridge, method, path: route,
      headers: { Host: `127.0.0.1:${bridge}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const login = await call("POST", "/auth/login", JSON.stringify({ password: PASS }), { Origin: origin });
  assert.equal(login.status, 200, login.text);
  const cookie = { Cookie: login.headers["set-cookie"][0].split(";")[0], Origin: origin };
  assert.equal((await call("GET", "/magic/widget?box=0", null, cookie)).status, 200);
  await pause(1100);
  const rev = (await card("0")).magic.rev;
  const sent = await call("POST", `/magic/send?box=0&rev=${rev}&op=${op()}`, JSON.stringify({ text: "from the phone", about: "t3" }), cookie);
  assert.equal(sent.status, 200, sent.text);
  assert.equal((await call("POST", `/magic/state?box=0&rev=${rev}`, JSON.stringify({ state: { shown: "t3" } }), cookie)).status, 200);
  assert.equal((await call("POST", "/magic/answer?box=0&about=t3", "from the phone", cookie)).status, 404);
  assert.equal((await record("0")).thread.at(-1).text, "from the phone");
  await claim();
  assert.equal((await agent("POST", "/magic/answer?box=0&about=t3", "Seen.")).body.released, true);
});

test("a card deleted for good takes its widget's record with it, and one with a conversation is not empty", async () => {
  const id = (await agent("POST", "/create?owner=facilitator", "")).body.id;
  await fill(id);
  const rev = (await card(id)).magic.rev;
  assert.equal((await page("POST", `/magic/state?box=${id}&rev=${rev}`, JSON.stringify({ state: { shown: "t1" } }))).status, 200);
  const mine = async () => (await readdir(path.join(board.data, "magic-boxes"))).filter(n => n.startsWith(id + "@"));
  assert.deepEqual(await mine(), [`${id}@issues.widget.json`]);
  assert.equal((await agent("POST", `/close?box=${id}`)).status, 200);
  assert.equal(await card(id), undefined, "an empty card was kept");
  assert.deepEqual(await mine(), []);
  // a card whose widget holds a conversation is closed, never deleted
  const talked = (await agent("POST", "/create?owner=facilitator", "")).body.id;
  await fill(talked);
  await pause(1100);
  assert.equal((await send(talked, "keep this", "t1")).status, 200);
  await claim();
  await agent("POST", `/magic/answer?box=${talked}&about=t1`, "Kept.");
  assert.equal((await agent("POST", `/close?box=${talked}`)).status, 200);
  assert.equal((await card(talked)).done, true);
});
