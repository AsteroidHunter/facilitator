// "Replace curse words" through the real routes: with the board's expletives
// setting on, the reader's own messages are saved with their curse words
// replaced by [expletive] (_curse_free in server.py, expletives.py), from the
// Mac board's page and the phone, typed, spoken and in a widget, so the saved
// state, the transcript, the search index, both pages' readings and every
// agent route (/wait, /fresh, /thread, /history, /magic/widget) hold only the
// masked words. An agent's own message is kept as it came; with the switch off,
// as it always was, nothing changes; a retried send matches its receipt; and a
// word list that cannot be read refuses the message rather than keep the words.
// The board is the fixture copy on a free port with a phone password; every
// card and message is invented. No browser is started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { readFile, readdir, rename, writeFile } = require("node:fs/promises");
const { request } = require("node:http");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PASS = "curse-fixture-pass-7";
const SEED = { title: "curse words board", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
  { id: "7", bucket: "now", title: "Card the reader types on", owner: "facilitator" },
  { id: "8", bucket: "now", title: "Card typed on with the switch off", owner: "orchard" },
  { id: "9", bucket: "now", title: "Card an agent writes on", owner: "pastureland" },
  { id: "10", bucket: "now", title: "Card with a widget", owner: "meadow" },
] };
// the reader's words, and what the board keeps of them with the switch on
const TYPED = "this is fucking broken, you ass, and unfuckingbelievable";
const TYPED_KEPT = "this is [expletive] broken, you [expletive], and un[expletive]believable";
const PHONED = "FUUUCK this phone, a classy assessment of shit";
const PHONED_KEPT = "[expletive] this phone, a classy assessment of [expletive]";
const SPOKEN = "spoken words: what the hell, un-fucking-believable";
const SPOKEN_KEPT = "spoken words: what the [expletive], un-[expletive]-believable";
const LATER = "a later message, still fucking broken";
const LATER_KEPT = "a later message, still [expletive] broken";
const WIDGET = "the widget is shit";
const WIDGET_KEPT = "the widget is [expletive]";
// every raw curse word above, which nothing the board keeps or answers may hold
const RAW = /fuck|fuuuck|shit|\bass\b|\bhell\b/i;
const WARM = "an invented first message with nothing to replace";

let board;
before(async () => {
  board = await startBoard({ seed: SEED, extra: ["expletives.py", "expletives.txt", "card_search.py"],
    prepare: async ({ app }) => {
      execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
      // these cases are about the words kept, not the typing hold, so a message
      // sent here is free to go out at once
      const file = path.join(app, "server.py");
      const source = await readFile(file, "utf8");
      const patched = source.replace("TYPING_HOLD = 3.5", "TYPING_HOLD = 0.0");
      assert.notEqual(patched, source, "test server typing hold was not patched");
      await writeFile(file, patched);
    } });
  // a seeded card's first answer is recorded as unknown (the answered batches'
  // upgrade), so card 7 is answered once first, with words that hold no curse
  ok(await page("/send?box=7", WARM), "the warm-up send");
  await claim("facilitator");
  ok(await agent("/reply?box=7", "an invented answer before the test"), "the warm-up reply");
});
after(async () => { if (board) await board.stop(); });

const parse = r => { try { return { status: r.status, body: JSON.parse(r.text) }; } catch { return { status: r.status, body: r.text }; } };
// the board's own page, with the headers a browser puts on every write
const page = async (route, body = "", method = "POST") => parse(await board.call(method, route, body));
// an agent: no browser headers, as curl and the scripts send
async function agent(route, body, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(board.origin + route, { method, body });
  return { status: r.status, body: await r.json().catch(() => null), raw: r };
}
// the phone, signed in through its own door on the port above the board's
async function phone(route, body = "", method = "POST") {
  const bridge = board.port + 1, origin = `http://127.0.0.1:${bridge}`;
  const call = (verb, where, bytes, headers) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: bridge, method: verb, path: where,
      headers: { Host: `127.0.0.1:${bridge}`, Origin: origin, ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
  if (!board.phoneCookie) {
    const login = await call("POST", "/auth/login", JSON.stringify({ password: PASS }), {});
    assert.equal(login.status, 200, login.text);
    board.phoneCookie = login.headers["set-cookie"][0].split(";")[0];
  }
  return parse(await call(method, route, method === "GET" ? undefined : body, { Cookie: board.phoneCookie }));
}
const ok = (said, what) => { assert.equal(said.status, 200, `${what}: ${JSON.stringify(said.body)}`); return said.body; };
async function stored(box) {
  const state = JSON.parse(await readFile(path.join(board.data, "state.json"), "utf8"));
  return state.boxes.find(b => b.id === box);
}
const rows = async (box, kind = "user") => (await readFile(path.join(board.data, "transcript.jsonl"), "utf8"))
  .split("\n").filter(Boolean).map(line => JSON.parse(line))
  .filter(row => row.box === box && row.kind === kind && row.text !== WARM);
const live = async (box, reading = "/state") => (await agent(reading)).body.boxes.find(b => b.id === box);
// every file the board keeps under data/, read as bytes, for the raw words
async function everyFile(folder = board.data) {
  const out = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const where = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...await everyFile(where));
    else out.push([where, (await readFile(where)).toString("latin1")]);
  }
  return out;
}
const clean = (answer, what) => assert.doesNotMatch(JSON.stringify(answer), RAW, `${what} holds a raw curse word`);
async function claim(owner) {
  const handed = ok(await agent(`/wait?owner=${owner}&timeout=5&agent=claude`), "/wait");
  ok(await agent(`/ack?owner=${owner}&token=${handed.ack}`, ""), "/ack");
  return handed;
}

test("with the switch off, as on every board until it is turned on, the reader's words are kept as sent", async () => {
  const settings = ok(await page("/settings", "", "GET"), "/settings");
  assert.equal(settings.values.expletives, undefined, "the switch is on before anyone turned it on");
  ok(await page("/send?box=8", TYPED), "the page's send");
  ok(await phone("/send?box=8&op=phoneoff0001", PHONED), "the phone's send");
  assert.deepEqual((await stored("8")).pending.map(m => m.text), [TYPED, PHONED]);
  assert.deepEqual((await rows("8")).map(r => r.text), [TYPED, PHONED]);
});

test("the switch is the board's own setting, set from the page and the phone alike", async () => {
  ok(await phone("/settings", JSON.stringify({ expletives: "1" })), "the phone's flip on");
  assert.equal(ok(await page("/settings", "", "GET"), "/settings").values.expletives, "1");
  ok(await page("/settings", JSON.stringify({ expletives: null })), "the page's flip off");
  assert.equal(ok(await phone("/settings", "", "GET"), "/settings").values.expletives, undefined);
  ok(await page("/settings", JSON.stringify({ expletives: "1" })), "the page's flip on");
  const kept = JSON.parse(await readFile(path.join(board.data, "settings.json"), "utf8"));
  assert.equal(kept.values.expletives, "1");
});

test("with the switch on, the reader's messages are saved masked and every reading and agent route has only those", async () => {
  ok(await page("/send?box=7&op=pagesend0001", TYPED), "the page's send");
  ok(await phone("/send?box=7&op=phonesend0001", PHONED), "the phone's send");
  ok(await page("/send?box=7&via=voice", SPOKEN), "the page's spoken send");
  const want = [TYPED_KEPT, PHONED_KEPT, SPOKEN_KEPT];

  // the saved message and its transcript row
  assert.deepEqual((await stored("7")).pending.map(m => m.text), want);
  assert.deepEqual((await rows("7")).map(r => r.text), want);
  // both pages' readings
  assert.deepEqual((await live("7")).pendingTexts, want, "the Mac board's reading");
  const phoneCard = ok(await phone("/m/state", "", "GET"), "/m/state").boxes.find(b => b.id === "7");
  clean(phoneCard, "the phone's reading");
  assert.match(JSON.stringify(phoneCard), /un\[expletive\]believable/);

  // the agent: /wait hands the masked words over
  const handed = await claim("facilitator");
  assert.equal(handed.box, "7");
  assert.deepEqual(handed.messages, want);
  clean(handed, "/wait");
  // /fresh, for a message sent while it works
  ok(await page("/send?box=7&via=mini", LATER), "the small card's send");
  const fresh = ok(await agent("/fresh?owner=facilitator"), "/fresh");
  assert.deepEqual(fresh.messages, [LATER_KEPT]);
  ok(await agent("/reply?box=7", "an invented answer"), "/reply");
  // /thread, and once a second answer lands, the history
  const thread = ok(await agent("/thread?box=7&n=60"), "/thread");
  assert.deepEqual(thread.messages.filter(m => m.kind === "user" && m.text !== WARM).map(m => m.text), [...want, LATER_KEPT]);
  clean(thread, "/thread");
  ok(await page("/send?box=7", "one more, damn it"), "a second send");
  assert.deepEqual((await claim("facilitator")).messages, ["one more, [expletive] it"]);
  ok(await agent("/reply?box=7", "an invented second answer"), "the second /reply");
  const history = ok(await agent("/history?box=7"), "/history");
  assert.match(JSON.stringify(history), /un\[expletive\]believable/, "the history lost the older batch");
  clean(history, "/history");
  // card 8 holds the words sent with the switch off, so only this card is read
  clean(await live("7"), "/state");
});

test("a retried send is answered from its receipt, whatever the switch says now", async () => {
  const again = ok(await page("/send?box=7&op=pagesend0001", TYPED), "the same send again");
  assert.equal(again.replayed, true, "the retry was not taken for the first try");
  ok(await page("/settings", JSON.stringify({ expletives: null })), "the flip off");
  assert.equal(ok(await phone("/send?box=7&op=phonesend0001", PHONED), "the phone's retry").replayed, true);
  ok(await page("/settings", JSON.stringify({ expletives: "1" })), "the flip on");
  assert.equal((await rows("7")).filter(r => r.text === TYPED_KEPT || r.text === PHONED_KEPT).length, 2,
    "a retry landed a second time");
});

test("a widget's message is saved masked, in its record and on its way to the agent", async () => {
  ok(await agent("/magic?box=10&kind=html&widget=issues", "<!doctype html><p>a widget</p>"), "the widget");
  const rev = (await live("10")).magic.rev;
  ok(await page(`/magic/send?box=10&rev=${rev}&op=widgetsend001`, JSON.stringify({ text: WIDGET, about: "" })), "the widget's send");
  const record = ok(await agent("/magic/widget?box=10"), "/magic/widget");
  assert.deepEqual(record.thread.map(m => m.text), [WIDGET_KEPT]);
  const handed = await claim("meadow");
  assert.deepEqual(handed.widget_messages.map(m => m.text), [WIDGET_KEPT]);
  assert.deepEqual((await rows("10", "widget")).map(r => r.text), [WIDGET_KEPT]);
});

test("an agent's own message is kept as it came, with the switch on", async () => {
  const words = "an agent quoting the reader: what the fuck";
  ok(await agent("/send?box=9", words), "the agent's send");
  ok(await page("/send?box=9&by=agent&agent=voice-assistant", "an assistant's shit, as it said it"), "a page's send for an agent");
  assert.deepEqual((await stored("9")).pending.map(m => [m.text, m.by]),
    [[words, "agent"], ["an assistant's shit, as it said it", "agent"]]);
});

test("nothing the board keeps holds the reader's raw words, the search index included", async () => {
  // the index reads the transcript on its own thread: wait for the messages to be in it
  const deadline = Date.now() + 20000;
  for (;;) {
    const status = (await agent("/search/status")).body;
    if (status && status.ready && status.messages >= 6) break;
    if (Date.now() > deadline) assert.fail("the search index did not take the messages in: " + JSON.stringify(status));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // card 8's words were sent with the switch off and card 9's by an agent
  const mine = answer => answer.results.filter(r => r.card === "7" || r.card === "10");
  const found = mine(ok(await agent("/search?q=broken"), "/search"));
  assert.ok(found.length >= 1, "the search found nothing");
  assert.match(JSON.stringify(found), /\[expletive\] broken/);
  clean(found, "/search");
  assert.deepEqual(mine(ok(await agent("/search?q=fucking"), "/search")), [], "the search finds a raw curse word");
  assert.deepEqual(mine(ok(await agent("/search?q=shit"), "/search")), [], "the search finds a raw curse word");
  // the files: everything under data/ but the agents' own messages on card 9,
  // the switch-off card 8 and the typed words of the tests above
  const allowed = [TYPED, PHONED, "an agent quoting the reader: what the fuck", "an assistant's shit, as it said it"];
  // and the board's own logs, which carry a message's length and never its words
  for (const [where, bytes] of [...await everyFile(), ...await everyFile(board.logs).catch(() => [])]) {
    let left = bytes;
    for (const words of allowed) left = left.split(words).join("").split(JSON.stringify(words).slice(1, -1)).join("");
    if (/search/.test(path.basename(where))) continue;   // checked through the route above: it holds card 8's and 9's words
    assert.doesNotMatch(left, /fucking broken, you ass|FUUUCK|un-fucking|widget is shit|damn it|what the hell/,
      `${where} holds the reader's raw words`);
  }
});

test("with the switch off again the words are kept as sent", async () => {
  ok(await page("/settings", JSON.stringify({ expletives: null })), "the flip off");
  ok(await page("/send?box=8", "off again, shit"), "the page's send");
  assert.equal((await stored("8")).pending.at(-1).text, "off again, shit");
  ok(await page("/settings", JSON.stringify({ expletives: "1" })), "the flip on");
});

test("a word list that cannot be read refuses the message and keeps nothing", async () => {
  const list = path.join(board.app, "expletives.txt");
  await rename(list, list + ".away");
  try {
    const before = (await stored("8")).pending.length;
    const refused = await page("/send?box=8&op=pagesend0099", "this shit must not be kept");
    assert.equal(refused.status, 503);
    assert.match(refused.body.error, /curse word list could not be read/);
    assert.equal((await stored("8")).pending.length, before, "a message was kept");
    assert.equal((await rows("8")).filter(r => /must not be kept/.test(r.text)).length, 0);
    const rev = (await live("10")).magic.rev;
    assert.equal((await page(`/magic/send?box=10&rev=${rev}`, JSON.stringify({ text: "widget shit", about: "" }))).status, 503);
    // an agent's message does not go through the list
    ok(await agent("/send?box=9", "an agent's words go on"), "the agent's send");
  } finally {
    await rename(list + ".away", list);
  }
  ok(await page("/send?box=8&op=pagesend0099", "this shit must not be kept"), "the same send once the list is back");
  assert.equal((await stored("8")).pending.at(-1).text, "this [expletive] must not be kept");
});
