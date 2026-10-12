// A card's magic box through the real routes: what an agent sends is kept
// beside state.json for that card alone, the card says only that a box exists,
// the page reads the content back as JSON (a picture with the upload's
// sandbox), closing hides without losing anything, and nothing the board would
// not keep for a message is kept for a box. No browser is started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile, readdir, stat } = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, startBoard } = require("./board-fixture.cjs");

let board;

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(64, 7)]);
const CLEAN_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
const SCRIPT_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>');

before(async () => { board = await startBoard(); });
after(async () => { if (board) await board.stop(); });

const open = (box, kind, body, extra = "") =>
  fetch(`${board.origin}/magic?box=${encodeURIComponent(box)}&kind=${kind}${extra}`, { method: "POST", body });
const json = async response => ({ status: response.status, body: await response.json() });
const card = async id => (await (await fetch(board.origin + "/state")).json()).boxes.find(b => b.id === id);
const files = async () => (await readdir(path.join(board.app, "magic-boxes")).catch(() => [])).filter(n => !n.startsWith("."));

test("each kind is kept, answered and read back for its own card", async () => {
  const cases = [["text", "plain *words*\nsecond line"], ["markdown", "# Title\n\n- one"],
    ["html", "<!doctype html><p id=x>hi</p><script>x.textContent='ran'</script>"]];
  for (const [kind, words] of cases) {
    const answer = await json(await open("0", kind, words, "&title=" + encodeURIComponent("A  title")));
    assert.equal(answer.status, 200, kind);
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.kind, kind);
    assert.equal(answer.body.shown, "inline");
    const read = await fetch(`${board.origin}/magic/body?box=0`);
    assert.equal(read.headers.get("content-type"), "application/json");
    assert.equal(read.headers.get("x-content-type-options"), "nosniff");
    assert.equal(read.headers.get("cache-control"), "no-store");
    const body = await read.json();
    assert.equal(body.kind, kind);
    assert.equal(body.title, "A title", "spaces in a title are collapsed");
    assert.equal(body.rev, answer.body.rev);
    assert.equal(body[kind === "html" ? "html" : "text"], words);
    const magic = (await card("0")).magic;
    assert.deepEqual({ open: magic.open, kind: magic.kind, rev: magic.rev }, { open: true, kind, rev: answer.body.rev });
  }
  assert.equal((await card("1.1")).magic, undefined, "a card with no box carries no field");
});

test("a picture is kept by what it is and served unable to run anything", async () => {
  for (const [bytes, type] of [[PNG, "image/png"], [CLEAN_SVG, "image/svg+xml"]]) {
    const answer = await json(await open("0", "image", bytes));
    assert.equal(answer.status, 200);
    const body = await (await fetch(`${board.origin}/magic/body?box=0`)).json();
    assert.equal(body.src, `/magic/img?box=0&rev=${answer.body.rev}`);
    const picture = await fetch(board.origin + body.src);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), type);
    assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
    assert.equal(picture.headers.get("content-security-policy"), "sandbox");
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()), bytes);
  }
});

test("only the newest revision's files are kept, owner-only", async () => {
  await open("0", "image", PNG);
  const last = (await json(await open("0", "markdown", "kept"))).body.rev;
  assert.deepEqual(await files(), [`0-${last}.json`]);
  assert.equal((await stat(path.join(board.app, "magic-boxes"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(board.app, "magic-boxes", `0-${last}.json`))).mode & 0o777, 0o600);
});

test("closing hides the box and keeps it; reopening shows it again", async () => {
  const rev = (await json(await open("0", "text", "still here"))).body.rev;
  let answer = await json(await fetch(`${board.origin}/magic/close?box=0`, { method: "POST" }));
  assert.deepEqual(answer, { status: 200, body: { ok: true, box: "0", open: false, rev } });
  assert.equal((await card("0")).magic.open, false);
  const kept = await (await fetch(`${board.origin}/magic/body?box=0`)).json();
  assert.equal(kept.text, "still here");
  answer = await json(await fetch(`${board.origin}/magic/reopen?box=0`, { method: "POST" }));
  assert.equal(answer.body.open, true);
  assert.equal((await card("0")).magic.open, true);
  const described = await json(await fetch(`${board.origin}/magic?box=0`));
  assert.equal(described.status, 200);
  assert.deepEqual(Object.keys(described.body).sort(), ["box", "kind", "open", "rev", "shown", "title", "ts"]);
});

test("a box's lines are chosen once as it opens and kept with it; each new box gets another than the box before it", async () => {
  const close = id => fetch(`${board.origin}/magic/close?box=${encodeURIComponent(id)}`, { method: "POST" });
  const lines = async id => (await card(id)).magic.lines;
  // a fill that opens a closed or empty box chooses; one of the two
  await close("0");
  await open("0", "text", "a new box");
  const chosen = await lines("0");
  assert.ok([0, 1].includes(chosen), "lines " + chosen);
  // the agent's next revisions, a close and a reopen keep them
  await open("0", "markdown", "revised");
  await open("0", "html", "<p>revised again</p>");
  assert.equal(await lines("0"), chosen);
  await close("0");
  assert.equal(await lines("0"), chosen, "a closed box keeps its lines");
  await fetch(`${board.origin}/magic/reopen?box=0`, { method: "POST" });
  assert.equal(await lines("0"), chosen);
  // and a restart
  await board.restart();
  assert.equal(await lines("0"), chosen);
  // new boxes, on one card and another of its own: never the previous new box's
  const other = (await (await fetch(`${board.origin}/create?owner=facilitator`, { method: "POST", body: "" })).json()).id;
  const seen = [chosen];
  for (let i = 0; i < 12; i++) {
    const id = i % 2 ? other : "0";
    await close(id);
    await open(id, "text", "new box " + i);
    seen.push(await lines(id));
  }
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], "the same lines twice in a row: " + seen);
  // with two to choose from they take turns, and the third is never given again
  for (const k of [0, 1]) assert.ok(seen.includes(k), "never " + k + ": " + seen);
  assert.ok(seen.every(k => k === 0 || k === 1), "a layout that is gone: " + seen);
  await close(other);
  await fetch(`${board.origin}/close?box=${other}`, { method: "POST" });
  // a box that kept the third before it was taken out is still one box with
  // one layout: the second, through every revision, and never another
  await close("0");
  await open("0", "text", "opened before the change");
  await board.restart(async () => {
    const file = path.join(board.app, "state.json"), state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.boxes.find(b => b.id === "0").magic.lines = 2;
    fs.writeFileSync(file, JSON.stringify(state));
  });
  assert.equal(await lines("0"), 2, "the board did not read the older box's lines");
  await open("0", "markdown", "revised");
  assert.equal(await lines("0"), 1, "a box with the third's lines is given the second's");
  await open("0", "text", "revised again");
  assert.equal(await lines("0"), 1);
  // an agent reading its box back is not told
  const described = await json(await fetch(`${board.origin}/magic?box=0`));
  assert.ok(!("lines" in described.body));
});

test("what is wrong is refused and nothing is kept for it", async () => {
  const before = await card("0");
  const refusals = [
    [await open("nope", "text", "x"), 400],
    [await open("0", "video", "x"), 400],
    [await open("0", "text", "   \n"), 400],
    [await open("0", "text", "x", "&title=" + "t".repeat(121)), 400],
    [await open("0", "text", Buffer.alloc(1024 * 1024 + 1, 97)), 413],
    [await open("0", "image", Buffer.alloc(10 * 1024 * 1024 + 1, 1)), 413],
    [await open("0", "image", Buffer.from("<html><body>not a picture</body></html>")), 415],
    [await open("0", "image", SCRIPT_SVG), 415],
    [await fetch(`${board.origin}/magic/close?box=1.1`, { method: "POST" }), 404],
    [await fetch(`${board.origin}/magic/reopen?box=1.1`, { method: "POST" }), 404],
    [await fetch(`${board.origin}/magic?box=1.1`), 404],
    [await fetch(`${board.origin}/magic/body?box=1.1`), 404],
    [await fetch(`${board.origin}/magic/img?box=1.1`), 404],
    [await fetch(`${board.origin}/magic?box=nope`), 400],
  ];
  for (const [response, status] of refusals) assert.equal(response.status, status, await response.text());
  assert.deepEqual((await card("0")).magic, before.magic);
});

test("a web address that is not https or not public is refused before anything is fetched", async () => {
  const before = await card("0");
  for (const [kind, address] of [["url", "http://example.org/"], ["url", "https://127.0.0.1:1/"],
    ["url", "https://localhost/"], ["url", "https://printer.local/"], ["url", "https://[::1]/"],
    ["url", "https://example.org/\nhttps://example.com/"], ["url", "not an address"],
    ["image", "https://192.168.1.1/picture.png"], ["image", "http://example.org/picture.png"]]) {
    const answer = await json(await open("0", kind, address));
    assert.equal(answer.status, 400, `${kind} ${address}`);
    assert.equal(typeof answer.body.error, "string");
  }
  assert.deepEqual((await card("0")).magic, before.magic);
});

test("the transcript says a box was opened and closed, never what it held", async () => {
  await open("0", "markdown", "a secret plan", "&title=Secret");
  await fetch(`${board.origin}/magic/close?box=0`, { method: "POST" });
  const rows = (await readFile(path.join(board.app, "transcript.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line)).filter(row => row.kind === "magic");
  assert.ok(rows.length >= 2);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes("secret") && !text.includes("Secret"), text);
  assert.deepEqual(rows.at(-2).magic, "markdown");
  assert.equal(rows.at(-1).action, "close");
});

test("a box outlives a restart", async () => {
  const rev = (await json(await open("0", "text", "after restart"))).body.rev;
  await board.restart();
  const body = await (await fetch(`${board.origin}/magic/body?box=0`)).json();
  assert.equal(body.text, "after restart");
  assert.equal(body.rev, rev);
});

test("a card that is removed takes its box with it", async () => {
  const made = await (await fetch(`${board.origin}/create?owner=facilitator`, { method: "POST", body: "" })).json();
  await open(made.id, "text", "short lived");
  assert.ok((await files()).some(name => name.startsWith(made.id + "-")));
  assert.equal((await fetch(`${board.origin}/close?box=${made.id}`, { method: "POST" })).status, 200);
  assert.equal(await card(made.id), undefined, "an empty card is removed by close");
  assert.ok(!(await files()).some(name => name.startsWith(made.id + "-")));
});

test("another website cannot fill a box; through the phone's bridge a signed-in phone only reads and closes one", async () => {
  const refused = await board.call("POST", "/magic?box=0&kind=text", "from elsewhere",
    { Origin: "https://elsewhere.example", "Sec-Fetch-Site": "cross-site" });
  assert.equal(refused.status, 403);
  const gate = fs.readFileSync(path.join(ROOT, "bridge_gate.py"), "utf8");
  const local = gate.match(/LOCAL_ONLY = frozenset\(\{([^}]*)\}\)/)[1];
  // filling, reading back and reopening are the agents' on the Mac: never answered through the bridge
  for (const route of ["/magic", "/magic/reopen"]) {
    assert.ok(local.includes(`"${route}"`), route);
    const phone = await fetch(`http://127.0.0.1:${board.port + 1}${route}?box=0`);
    assert.equal(phone.status, 404, `${route} through the phone's port`);
  }
  // what a box holds, its picture and its red light are the phone's too, signed in only
  for (const [route, method] of [["/magic/body", "GET"], ["/magic/img", "GET"], ["/magic/close", "POST"]]) {
    assert.ok(!local.includes(`"${route}"`), route);
    const phone = await fetch(`http://127.0.0.1:${board.port + 1}${route}?box=0`, { method });
    assert.equal(phone.status, 401, `${route} through the phone's port with no session`);
  }
});
