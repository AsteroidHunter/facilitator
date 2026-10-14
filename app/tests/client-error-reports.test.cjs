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
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
             'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"');
  assert.notEqual(patched, source, "test server port was not patched");
  assert.match(patched, /TAILSCALE_APP = "\/facilitator-test\/no-tailscale-app"/);
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "client reports fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));

  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
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

const WINDOW = "0123456789abcdef";

test("every line says which kind of window sent it and which load of it, the dropped notice too", async () => {
  await reportsSince();
  const looping = report({ message: "one window repeating itself", line: 6161 });
  const sent = await send({
    page: "board", client: "tauri", window: WINDOW,
    reports: [report({ message: "first from the tauri window", line: 6100, box: "m12" }),
              ...Array.from({ length: 12 }, () => looping)],
  });
  assert.deepEqual(sent, { status: 200, body: { ok: true, written: 11, dropped: 2 } });
  const fresh = await reportsSince();
  assert.equal(fresh.length, 12);
  assert.deepEqual(fresh.map(line => line.kind).sort(), [...Array(11).fill("error"), "dropped"].sort());
  for (const line of fresh) {
    assert.equal(line.page, "board");
    assert.equal(line.client, "tauri", `a ${line.kind} line lost its client`);
    assert.equal(line.window, WINDOW, `a ${line.kind} line lost its window`);
  }
});

test("each window kind the pages name is stored as sent", async () => {
  await reportsSince();
  const names = ["chrome", "electron", "tauri", "safari", "phone", "other"];
  for (const [n, name] of names.entries()) {
    const sent = await send({ page: "board", client: name, window: WINDOW,
      reports: [report({ message: `thrown in the ${name} window`, line: 6300 + n })] });
    assert.equal(sent.status, 200, name);
  }
  const fresh = await reportsSince();
  assert.deepEqual(fresh.map(line => line.client), names);
});

test("a page from before the fields existed is still stored, with neither on its lines", async () => {
  await reportsSince();
  const sent = await send({ page: "board", reports: [report({ message: "an older page", line: 6400 })] });
  assert.equal(sent.status, 200);
  const [line] = await reportsSince();
  assert.equal(line.message, "an older page");
  assert.equal("client" in line, false);
  assert.equal("window" in line, false);
});

test("a client name or window id outside the fixed forms is refused and nothing is stored", async () => {
  const before = (await reports()).length;
  for (const bad of [
    { client: "firefox" }, { client: "Chrome" }, { client: "" }, { client: null }, { client: 7 },
    { client: true }, { client: ["tauri"] }, { client: { name: "tauri" } },
    { client: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" },
    { window: "" }, { window: "0123" }, { window: "0123456789abcdef0" }, { window: "0123456789ABCDEF" },
    { window: "0123456789abcdeg" }, { window: "0123456789abcdef\n" }, { window: 1234567890123456 },
    { window: null }, { window: ["0123456789abcdef"] }, { window: "x".repeat(4000) },
    { window: "http://127.0.0.1:8877/" }, { client: "tauri", window: "nope" },
    { client: "nope", window: WINDOW },
  ]) {
    const refused = await send({ page: "board", ...bad, reports: [report({ line: 6500 })] });
    assert.equal(refused.status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal(refused.body.error, "bad report batch");
  }
  assert.equal((await reports()).length, before, "a refused batch wrote something");
});

test("a report cannot carry a client or window of its own into the line", async () => {
  await reportsSince();
  const sent = await send({ page: "board", client: "electron", window: WINDOW,
    reports: [report({ message: "a report claiming another window", line: 6600,
                       client: "chrome", window: "fedcba9876543210" })] });
  assert.equal(sent.status, 200);
  const [line] = await reportsSince();
  assert.equal(line.client, "electron");
  assert.equal(line.window, WINDOW);
});

function incident() {
  return { kind: "incident", v: 1, reason: "manual", marked: 1800000000000,
    box: "m12", lost: 0, suppressed: 0, events: [
      { event: "request", phase: "start", route: "/send", op: "12345678-1234-4234-8234-123456789abc",
        seq: 1, box: "m12", at: -300, visible: true, online: true, resume: 0 },
      { event: "request", phase: "end", ms: 250, serverMs: 15, status: 200, seq: 1, at: -50,
        visible: true, online: true, resume: 0 },
      { event: "mark", reason: "manual", source: "settings", box: "m12", selected: "m12", at: 0,
        known: true, present: true, shown: true, title: true, titled: true, emptyTitle: false,
        visible: true, online: true, resume: 0 },
    ] };
}

test("incident validation rejects content, unbounded nesting, bad types and unknown versions atomically", async () => {
  const before = (await reports()).length;
  const mutations = [
    r => { r.message = "private text"; }, r => { r.v = 3; }, r => { r.v = true; },
    r => { r.box = "person@example.invalid"; }, r => { r.marked = "yesterday"; },
    r => { r.reason = { text: "private" }; }, r => { r.events = Array(41).fill(r.events[2]); },
    r => { r.events = []; }, r => { r.events[0].at = -60001; }, r => { r.events[1].at = -301; },
    r => { r.events[0].url = "https://private.invalid/?key=secret"; },
    r => { r.events[0].route = "/send?box=m12&op=private"; }, r => { r.events[0].op = "private-token-value"; },
    r => { r.events[0].visible = 1; }, r => { r.events[0].event = ["request"]; },
    r => { r.events[0].ms = 600001; }, r => { r.events[0].ms = 0.5; },
    r => { r.events[0].status = null; }, r => { r.events[0].data = { title: "private" }; },
    r => { delete r.events[0].resume; }, r => { r.events[2].reason = "invariant"; },
    r => { r.events[2].selected = "/private/path"; },
  ];
  for (const mutate of mutations) {
    const r = incident(); mutate(r);
    const response = await send({ page: "phone", reports: [report({ line: 9988 }), r] });
    assert.equal(response.status, 400, JSON.stringify(r));
    assert.equal(response.body.error, "bad incident history");
  }
  assert.equal((await send({ page: "board", reports: [incident()] })).status, 400);
  assert.equal((await reports()).length, before, "an invalid incident wrote part of its batch");
});

test("v2 incident metadata is strict and persisted without content", async () => {
  await reportsSince();
  const revised = incident();
  revised.v = 2;
  revised.build = "phone-diag-test-1";
  revised.events.splice(-1, 0,
    { event:"stage", stage:"editor-init", phase:"end", ms:3, editor:true, editorReady:true,
      formatted:true, box:"m12", at:-25, visible:true, online:true, resume:0 },
    { event:"observer", observer:"undelivered", at:-20, visible:true, online:true, resume:0 });
  assert.deepEqual(await send({ page:"phone", reports:[revised] }),
    { status:200, body:{ ok:true, written:1, dropped:0 } });
  const [written] = await reportsSince();
  assert.equal(written.v, 2);
  assert.equal(written.build, "phone-diag-test-1");
  assert.ok(written.events.some(e => e.stage === "editor-init" && e.editorReady));
  for (const mutate of [r => { delete r.build; }, r => { r.build = "private words"; }, r => { r.events[2].sourceText = "private"; }]) {
    const bad = structuredClone(revised); mutate(bad);
    assert.equal((await send({ page:"phone", reports:[bad] })).status, 400);
  }
});

test("v3 accepts bounded prelude and recovery events while rejecting private fields", async () => {
  await reportsSince();
  const revised = incident();
  revised.v = 3;
  revised.build = "phone-diag-test-3";
  revised.worker = "facilitator-m-5";
  revised.session = "0123456789abcdef";
  revised.events = [
    { event:"input", action:"response-scroll", part:"touch", at:-119000,
      visible:true, online:true, resume:1 },
    { event:"poll", count:8, ms:225, serverMs:3, at:-10000,
      visible:true, online:true, resume:1 },
    { event:"mark", reason:"manual", source:"settings", at:0,
      visible:true, online:true, resume:1 },
    { event:"frame", ms:1250, at:1000, visible:true, online:true, resume:1 },
    { event:"scroll", action:"response-scroll", phase:"end", ms:1900,
      count:17, at:19000, visible:true, online:true, resume:1 },
  ];
  assert.deepEqual(await send({ page:"phone", client:"phone", window:revised.session, reports:[revised] }),
    { status:200, body:{ ok:true, written:1, dropped:0 } });
  const [written] = await reportsSince();
  assert.deepEqual(written.events, revised.events);
  assert.equal(written.worker, "facilitator-m-5");
  assert.equal(written.window, written.session, "the phone's session is its window id");
  const changes = [
    r => { r.events[0].text = "private message"; },
    r => { r.events[0].x = 42; },
    r => { r.events[0].at = -120001; },
    r => { r.events.at(-1).at = 20001; },
    r => { r.events[2].at = 1; },
    r => { r.events.push({ ...r.events[2] }); },
    r => { r.worker = "bad worker name"; },
    r => { r.session = "private-token"; },
    r => { r.events[0].action = "private"; },
    r => { r.events = Array(129).fill(r.events[2]); },
  ];
  for (const mutate of changes) {
    const bad = structuredClone(revised); mutate(bad);
    assert.equal((await send({ page:"phone", reports:[bad] })).status, 400);
  }
  assert.equal((await reportsSince()).length, 0, "rejected v3 batches wrote nothing");
});

test("v4 keeps bounded Enter decisions and rejects private or malformed fields", async () => {
  await reportsSince();
  const entry = { event:"enter", step:"capture", branch:"seen", at:-200,
    visible:true, online:true, resume:1, base:812, inner:764, vh:696, vt:0,
    scale:100, kb:true, target:"editor", focus:"editor", draft:true,
    key:"Enter", code:"NumpadEnter", keyCode:13, shift:false, repeat:false,
    composing:false, prevented:false };
  const revised = incident();
  revised.v = 4;
  revised.build = "phone-enter-diag-test";
  revised.worker = "facilitator-m-7";
  revised.session = "0123456789abcdef";
  revised.events = [entry,
    { ...entry, step:"handler", branch:"keyboard", at:-190 },
    { event:"enter", step:"beforeinput", branch:"line-intent", inputType:"insertLineBreak",
      at:-180, visible:true, online:true, resume:1, base:812, inner:764, vh:696, vt:0,
      scale:100, kb:true, target:"editor", focus:"editor", draft:true, prevented:false },
    { event:"mark", reason:"manual", source:"settings", at:0,
      visible:true, online:true, resume:1 }];
  assert.deepEqual(await send({ page:"phone", reports:[revised] }),
    { status:200, body:{ ok:true, written:1, dropped:0 } });
  const [written] = await reportsSince();
  assert.deepEqual(written.events, revised.events);
  const changes = [
    r => { r.events[0].text = "private draft"; },
    r => { r.events[0].key = "a typed character"; },
    r => { r.events[0].code = "KeyA"; },
    r => { r.events[0].target = "private field"; },
    r => { r.events[0].base = 10001; },
    r => { r.events[0].scale = 1.5; },
    r => { r.events[0].draft = "private draft"; },
    r => { delete r.events[0].step; },
    r => { r.events[2].inputType = "insertText"; },
    r => { r.events[3].keyCode = 13; },
    r => { r.v = 6; },
  ];
  for (const mutate of changes) {
    const bad = structuredClone(revised); mutate(bad);
    assert.equal((await send({ page:"phone", reports:[bad] })).status, 400);
  }
  assert.equal((await reportsSince()).length, 0, "rejected v4 batches wrote nothing");
});

test("a confirmed incident shares the dated client stream and leaves existing report fields intact", async () => {
  await reportsSince();
  const result = await send({ page: "phone", client: "phone", window: WINDOW,
    reports: [incident(), report({ line: 5950, message: "fixture failure" })] });
  assert.deepEqual(result, { status: 200, body: { ok: true, written: 2, dropped: 0 } });
  const lines = await reportsSince();
  assert.equal(lines.length, 2);
  for (const line of lines) assert.deepEqual([line.client, line.window], ["phone", WINDOW]);
  assert.deepEqual(lines[0].events, incident().events);
  assert.equal(lines[0].marked, 1800000000000);
  assert.equal(lines[0].box, "m12");
  assert.equal(lines[0].page, "phone");
  assert.equal(lines[1].message, "fixture failure");
  assert.ok((await readdir(logs)).some(n => /^client-\d{8}\.jsonl$/.test(n)));
  const transcript = await readFile(path.join(fixtureDir, "transcript.jsonl"), "utf8").catch(() => "");
  assert.doesNotMatch(transcript, /incident|fixture failure/);
});

test("different incident reasons, cards and operation ids share the four-write minute cap", async () => {
  await reportsSince();
  const reportsToSend = Array.from({ length: 10 }, (_, i) => {
    const r = incident();
    r.reason = i % 2 ? "invariant" : "slow-ui";
    r.events.at(-1).reason = r.reason;
    r.box = "m" + (100 + i);
    r.marked += i;
    return r;
  });
  const response = await send({ page: "phone", reports: reportsToSend });
  // The confirmed v1, v2, v3 and v4 cases above used the four shared writes.
  assert.deepEqual(response.body, { ok: true, written: 0, dropped: 10 });
  const fresh = await reportsSince();
  assert.equal(fresh.filter(r => r.kind === "incident").length, 0);
  assert.equal(fresh.filter(r => r.kind === "dropped").reduce((sum, r) => sum + r.dropped, 0), 10);
});

test("only the three phone operation routes expose a numeric server duration", async () => {
  const state = await fetch(origin + "/m/state");
  assert.match(state.headers.get("x-facilitator-duration-ms"), /^\d+$/);
  assert.equal((await state.json()).incidentSchema, 5);
  const ordinary = await fetch(origin + "/state");
  assert.equal(ordinary.headers.get("x-facilitator-duration-ms"), null);
  await ordinary.arrayBuffer();
  for (const route of ["/create?owner=facilitator", "/send?box=0"]) {
    const response = await fetch(origin + route, { method: "POST", body: "invented timing fixture" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-facilitator-duration-ms"), /^\d+$/);
    await response.arrayBuffer();
  }
});

// Last, because the four incident writes a minute are spent above: a v5 history
// this receiver reads is answered 200 and counted as dropped, and one it cannot
// read is a 400. The written v5 lines are in tests/test_incident_route.py.
test("v5 response gesture fields pass validation, are bounded, and are refused by older versions", async () => {
  await reportsSince();
  const v5 = incident();
  Object.assign(v5, { v:5, reason:"no-scroll", build:"phone-scroll-diag-test",
    worker:"facilitator-m-7", session:"0123456789abcdef" });
  v5.events = [
    { event:"input", action:"response-scroll", part:"touch", box:"m12", top:120, range:900,
      view:500, edge:"middle", hist:false, kb:false, focus:"none", lag:4,
      at:-400, visible:true, online:true, resume:1 },
    { event:"input", action:"response-scroll", part:"intent", box:"m12", dir:"up", far:true,
      edge:"middle", lag:3, at:-380, visible:true, online:true, resume:1 },
    { event:"mark", reason:"no-scroll", box:"m12", at:0, visible:true, online:true, resume:1 },
    { event:"input", action:"response-scroll", part:"touch-cancel", box:"m12", moved:0, count:0,
      ms:450, same:true, prevented:false, at:50, visible:true, online:true, resume:1 },
    { event:"phase", action:"response-scroll", part:"reply-swap", box:"m12", hist:true, ms:600,
      at:200, visible:true, online:true, resume:1 },
    { event:"scroll", action:"response-scroll", phase:"start", box:"m12", wait:900,
      at:500, visible:true, online:true, resume:1 },
  ];
  assert.deepEqual(await send({ page:"phone", reports:[v5] }),
    { status:200, body:{ ok:true, written:0, dropped:1 } });
  const changes = [
    r => { r.v = 4; },                                   // a v4 receiver has no no-scroll reason
    r => { r.v = 4; r.reason = "manual"; r.events[2].reason = "manual"; },   // nor these fields
    r => { r.events[0].edge = "left"; },
    r => { r.events[0].top = 1.5; },
    r => { r.events[0].range = 1000001; },
    r => { r.events[0].x = 180; },
    r => { r.events[1].dir = "sideways"; },
    r => { r.events[1].far = "yes"; },
    r => { r.events[0].focus = "private field"; },
    r => { r.events[3].part = "touch-lost"; },
    r => { r.events[2].reason = "manual"; },
    r => { r.events.splice(1, 0, { event:"request", phase:"end", top:5, at:-390,
      visible:true, online:true, resume:1 }); },         // gesture fields only on gesture events
    r => { r.events.splice(1, 0, { event:"input", action:"response-scroll", part:"taken",
      by:"private handler", at:-390, visible:true, online:true, resume:1 }); },
  ];
  for (const mutate of changes) {
    const bad = structuredClone(v5); mutate(bad);
    assert.equal((await send({ page:"phone", reports:[bad] })).status, 400, JSON.stringify(bad).slice(0, 120));
  }
  assert.equal((await reportsSince()).filter(r => r.kind === "incident").length, 0);
});

// ---- what the phone says about its notifications ----------------------------
// Three kinds, each of fixed words, flags and bounded numbers. A report with a
// field that is not listed or a value that is not allowed refuses the whole
// batch, so no address, key or text can be written down by sending one.
const { loadWorker, startPage } = require("./push-record-fixture.cjs");

const shownReport = (over = {}) => ({ kind: "pushreceived", outcome: "shown", ms: 41, status: 200, ago: 3, n: 7,
  worker: "facilitator-m-7", ...over });
const skippedReport = (over = {}) => ({ kind: "pushreceived", outcome: "skipped", reason: "timeout", ms: 6000,
  status: 0, ago: 3, n: 8, worker: "facilitator-m-7", ...over });
const checkReport = (over = {}) => ({ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "no", ...over });
const lostReport = (over = {}) => ({ kind: "notifylost", source: "return", reg: true, ...over });
const phone = list => ({ page: "phone", client: "phone", window: WINDOW, reports: list });

test("notification reports are stored as the fixed fields they are, with the time worked out from how long ago", async () => {
  await reportsSince();
  const asked = Date.now();
  const sent = await send(phone([
    shownReport(), skippedReport(), skippedReport({ reason: "check-failed", status: 503, n: 9 }),
    skippedReport({ reason: "not-signed-in", status: 200, n: 10 }), skippedReport({ reason: "show-failed", n: 11 }),
    skippedReport({ reason: "other", n: 12 }), checkReport(), lostReport(),
  ]));
  assert.deepEqual(sent, { status: 200, body: { ok: true, written: 8, dropped: 0 } });
  const fresh = await reportsSince();
  assert.deepEqual(fresh.map(line => line.kind), [...Array(6).fill("pushreceived"), "notifycheck", "notifylost"]);
  const allowed = new Set(["ts", "level", "kind", "box", "page", "client", "window", "outcome", "reason", "ms",
    "status", "n", "worker", "at", "source", "perm", "reg", "sub"]);
  for (const line of fresh) {
    for (const name of Object.keys(line)) assert.ok(allowed.has(name), `a ${line.kind} line carries ${name}`);
    assert.equal(line.page, "phone");
    assert.equal(line.client, "phone");
    assert.equal(line.window, WINDOW);
    assert.equal(line.level, "info");
  }
  const [shown, timedOut] = fresh;
  assert.deepEqual({ ...shown, ts: undefined, at: undefined }, {
    ts: undefined, level: "info", kind: "pushreceived", page: "phone", client: "phone", window: WINDOW,
    outcome: "shown", ms: 41, status: 200, n: 7, worker: "facilitator-m-7", at: undefined,
  });
  assert.match(shown.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const age = asked - Date.parse(shown.at);
  assert.ok(age > 2000 && age < 8000, `the time was not three seconds before the report: ${age} ms`);
  assert.deepEqual([timedOut.outcome, timedOut.reason, timedOut.ms, timedOut.status], ["skipped", "timeout", 6000, 0]);
  assert.deepEqual([fresh[6].source, fresh[6].perm, fresh[6].reg, fresh[6].sub], ["start", "granted", true, "no"]);
  assert.deepEqual([fresh[7].source, fresh[7].reg], ["return", true]);
});

test("a notification report with anything else in it is refused whole, and nothing is stored", async () => {
  const before = (await reports()).length;
  const secret = "https://push.example.test/send/very-secret-address";
  for (const [bad, error] of [
    [shownReport({ title: "Private card title" }), "bad notification report"],
    [shownReport({ endpoint: secret }), "bad notification report"],
    [shownReport({ box: "m12" }), "bad notification report"],
    [shownReport({ message: "text" }), "bad notification report"],
    [shownReport({ reason: "timeout" }), "bad notification report"],
    [skippedReport({ reason: undefined }), "bad notification report"],
    [skippedReport({ reason: "the title was Private" }), "bad notification report"],
    [skippedReport({ reason: secret }), "bad notification report"],
    [shownReport({ outcome: "delivered" }), "bad notification report"],
    [shownReport({ outcome: undefined }), "bad notification report"],
    [shownReport({ ms: -1 }), "bad notification report"],
    [shownReport({ ms: 600001 }), "bad notification report"],
    [shownReport({ ms: 1.5 }), "bad notification report"],
    [shownReport({ ms: "41" }), "bad notification report"],
    [shownReport({ ms: true }), "bad notification report"],
    [shownReport({ status: 600 }), "bad notification report"],
    [shownReport({ ago: 7776001 }), "bad notification report"],
    [shownReport({ n: 1e12 + 1 }), "bad notification report"],
    [shownReport({ n: null }), "bad notification report"],
    [shownReport({ worker: secret }), "bad notification report"],
    [shownReport({ worker: "Facilitator-M-7" }), "bad notification report"],
    [shownReport({ worker: "x".repeat(65) }), "bad notification report"],
    [shownReport({ worker: undefined }), "bad notification report"],
    [checkReport({ perm: "maybe" }), "bad notification report"],
    [checkReport({ perm: secret }), "bad notification report"],
    [checkReport({ sub: secret }), "bad notification report"],
    [checkReport({ sub: true }), "bad notification report"],
    [checkReport({ reg: "yes" }), "bad notification report"],
    [checkReport({ source: "boot" }), "bad notification report"],
    [checkReport({ endpoint: secret }), "bad notification report"],
    [checkReport({ keys: { p256dh: "x", auth: "y" } }), "bad notification report"],
    [checkReport({ sub: undefined }), "bad notification report"],
    [lostReport({ perm: "granted" }), "bad notification report"],
    [lostReport({ reg: 1 }), "bad notification report"],
    [lostReport({ source: undefined }), "bad notification report"],
    [{ kind: "notifybogus", source: "start" }, "bad report batch"],
    [{ kind: "pushrecieved", outcome: "shown" }, "bad report batch"],
  ]) {
    const refused = await send(phone([bad]));
    assert.equal(refused.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(refused.body.error, error);
  }
  // one good report beside one bad one stores neither
  assert.equal((await send(phone([checkReport(), checkReport({ perm: secret })]))).status, 400);
  // only the phone page speaks of notifications
  for (const page of ["board", "page"]) {
    assert.equal((await send({ page, reports: [checkReport()] })).status, 400, page);
  }
  assert.equal((await reports()).length, before, "a refused batch wrote something");
});

test("what the worker and the page really send is what the route takes, line for line", async () => {
  await reportsSince();
  const harness = await loadWorker();
  const posted = [];
  harness.board.log = async body => {
    const answer = await send(body);
    posted.push(answer);
    return { ok: answer.status === 200, status: answer.status };
  };
  harness.board.auth = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await harness.push({ box: "m12", title: "Private card title" });
  harness.board.auth = async () => ({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
  await harness.push();
  harness.board.auth = async () => { throw new TypeError("Load failed"); };
  await harness.push();
  harness.board.auth = async () => ({ ok: true, status: 200, json: async () => ({ authenticated: true }) });
  await harness.push({ box: "m12", title: "Private card title" });
  assert.deepEqual(posted.map(answer => answer.status), [200], "the board refused what the worker sent");
  assert.deepEqual(harness.idb.rows(), []);

  const fresh = await reportsSince();
  assert.deepEqual(fresh.map(line => [line.outcome, line.reason]),
    [["skipped", "check-failed"], ["skipped", "not-signed-in"], ["skipped", "check-failed"], ["shown", undefined]]);
  assert.deepEqual(fresh.map(line => line.n), [1, 2, 3, 4]);
  assert.ok(!JSON.stringify(fresh).includes("Private card title"), "a title reached the client file");

  for (const options of [{ subscription: "yes" }, { subscription: "no" }, { worker: "none" }, { permission: "unsupported" }]) {
    const page = startPage(options);
    await page.settle();
    const answer = await send({ page: "phone", client: "phone", window: WINDOW, reports: page.reports });
    assert.equal(answer.status, 200, JSON.stringify(options));
    assert.equal(answer.body.written, page.reports.length);
  }
  const pageLines = await reportsSince();
  assert.deepEqual(pageLines.map(line => line.kind), [
    "notifycheck", "notifycheck", "notifylost", "notifycheck", "notifylost", "notifycheck"]);
  assert.ok(!JSON.stringify(pageLines).includes("secret"), "an address reached the client file");
});

test("notification reports have their own caps: sixty pushes a minute, ten of the rest", async () => {
  await reportsSince();
  const all = await reports();
  const kept = kind => all.filter(line => line.kind === kind).length;
  const room = kind => (kind === "pushreceived" ? 60 : 10) - kept(kind);
  const pushed = room("pushreceived");
  let written = 0, dropped = 0;
  for (let from = 0; from < pushed + 5; from += 20) {
    const count = Math.min(20, pushed + 5 - from);
    const sent = await send(phone(Array.from({ length: count }, () => shownReport())));
    assert.equal(sent.status, 200);
    written += sent.body.written;
    dropped += sent.body.dropped;
  }
  assert.deepEqual([written, dropped], [pushed, 5], "the push record's cap did not hold at sixty");

  const checks = room("notifycheck");
  const sent = await send(phone(Array.from({ length: checks + 2 }, () => checkReport())));
  assert.deepEqual(sent.body, { ok: true, written: checks, dropped: 2 });
  const notices = (await reportsSince()).filter(line => line.kind === "dropped");
  assert.deepEqual(notices.map(line => [line.report, line.dropped]), [["pushreceived", 5], ["notifycheck", 2]]);
});
