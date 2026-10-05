// The route taps on a notification are reported to: three kinds, notifytap
// from the worker, notifyarrive and notifyresult from the page, each of fixed
// words, a card id, the tap's id and bounded numbers. A report with a field not
// listed or a value not allowed refuses the whole batch, so no title, key or
// address can be written down by sending one. One fixture server on a free port;
// the suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { loadWorker } = require("./push-record-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const WINDOW = "0123456789abcdef";

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

async function reports() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    if (!name.startsWith("client-")) continue;
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

let readSoFar = 0;
async function reportsSince() {
  const all = await reports();
  const fresh = all.slice(readSoFar);
  readSoFar = all.length;
  return fresh;
}

async function send(batch) {
  const response = await fetch(origin + "/clientlog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof batch === "string" ? batch : JSON.stringify(batch),
  });
  return { status: response.status, body: await response.json() };
}

const phone = list => ({ page: "phone", client: "phone", window: WINDOW, reports: list });
const tapReport = (over = {}) => ({ kind: "notifytap", box: "m101", tap: "deadbeef", windows: 1, route: "message",
  focus: "ok", ms: 12, age: 90, ...over });
const openReport = (over = {}) => tapReport({ windows: 0, route: "open", focus: "none", opened: "client", ...over });
const arriveReport = (over = {}) => ({ kind: "notifyarrive", tap: "deadbeef", box: "m101", via: "message",
  reading: "yes", found: "yes", visible: "yes", menu: "none", home: "no", hist: "no", ...over });
const resultReport = (over = {}) => ({ kind: "notifyresult", tap: "deadbeef", box: "m101", shown: "yes",
  covered: "none", pending: "no", ...over });
const without = (report, ...names) => { const kept = { ...report }; for (const name of names) delete kept[name]; return kept; };

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-notifytap-"));
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
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "tap reports fixture",
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

test("the three kinds are stored as the fixed fields they are, the card id as the line's own box", async () => {
  const sent = await send(phone([
    tapReport(), openReport({ opened: "rejected", age: undefined }),
    arriveReport(), arriveReport({ via: "url", reading: "no", found: "no", menu: "cards", home: "yes", hist: "yes" }),
    resultReport(), resultReport({ tap: "none", box: "", shown: "no", covered: "projects", pending: "yes" }),
  ]));
  assert.deepEqual(sent, { status: 200, body: { ok: true, written: 6, dropped: 0 } });
  const fresh = await reportsSince();
  assert.deepEqual(fresh.map(line => line.kind),
    ["notifytap", "notifytap", "notifyarrive", "notifyarrive", "notifyresult", "notifyresult"]);
  const allowed = {
    notifytap: ["box", "tap", "windows", "route", "focus", "opened", "ms", "age"],
    notifyarrive: ["tap", "box", "via", "reading", "found", "visible", "menu", "home", "hist"],
    notifyresult: ["tap", "box", "shown", "covered", "pending"],
  };
  for (const line of fresh) {
    const names = new Set(["ts", "level", "kind", "page", "client", "window", ...allowed[line.kind]]);
    for (const name of Object.keys(line)) assert.ok(names.has(name), `a ${line.kind} line carries ${name}`);
    assert.deepEqual([line.page, line.client, line.window, line.level], ["phone", "phone", WINDOW, "info"]);
  }
  const stripped = line => ({ ...line, ts: undefined });
  assert.deepEqual(stripped(fresh[0]), {
    ts: undefined, level: "info", kind: "notifytap", box: "m101", page: "phone", client: "phone", window: WINDOW,
    tap: "deadbeef", windows: 1, route: "message", focus: "ok", ms: 12, age: 90,
  });
  assert.deepEqual(stripped(fresh[1]), {
    ts: undefined, level: "info", kind: "notifytap", box: "m101", page: "phone", client: "phone", window: WINDOW,
    tap: "deadbeef", windows: 0, route: "open", focus: "none", opened: "rejected", ms: 12,
  });
  assert.deepEqual(stripped(fresh[3]), {
    ts: undefined, level: "info", kind: "notifyarrive", box: "m101", page: "phone", client: "phone", window: WINDOW,
    tap: "deadbeef", via: "url", reading: "no", found: "no", visible: "yes", menu: "cards", home: "yes", hist: "yes",
  });
  assert.deepEqual(stripped(fresh[5]), {
    ts: undefined, level: "info", kind: "notifyresult", page: "phone", client: "phone", window: WINDOW,
    tap: "none", shown: "no", covered: "projects", pending: "yes",
  });
});

test("every box a card has is accepted, and so is none", async () => {
  await reportsSince();
  const ids = ["m101", "t202", "7", "1.2", "12.3.4", "q", "", "9".repeat(32)];
  const makers = [tapReport, arriveReport, resultReport];
  const sent = await send(phone(ids.map((box, at) => makers[at % 3]({ box }))));
  assert.deepEqual(sent, { status: 200, body: { ok: true, written: 8, dropped: 0 } },
    "the cap or the checks dropped a card id");
  assert.deepEqual((await reportsSince()).map(line => line.box), ids.map(id => id || undefined));
});

test("a report with anything else in it is refused whole, and nothing is stored", async () => {
  const before = (await reports()).length;
  const secret = "https://push.example.test/send/very-secret-address";
  const bad = [
    // fields that are not listed
    tapReport({ title: "Private card title" }), tapReport({ endpoint: secret }), tapReport({ message: "text" }),
    tapReport({ worker: "facilitator-m-8" }), arriveReport({ title: "Private" }), arriveReport({ url: secret }),
    resultReport({ title: "Private" }), resultReport({ ago: 3 }),
    // fields that are missing
    without(tapReport(), "tap"), without(tapReport(), "route"), without(tapReport(), "box"),
    without(tapReport(), "windows"), without(tapReport(), "ms"), without(arriveReport(), "home"),
    without(arriveReport(), "tap"), without(resultReport(), "pending"), without(resultReport(), "box"),
    // the opened word belongs to a tap that asked for a window, and that one must have it
    tapReport({ opened: "client" }), without(openReport(), "opened"), openReport({ route: "failed" }),
    tapReport({ route: "failed", opened: "null" }),
    // words that are not on the list
    tapReport({ route: "close" }), tapReport({ route: secret }), tapReport({ focus: "yes" }),
    tapReport({ focus: true }), openReport({ opened: "window" }), openReport({ opened: secret }),
    arriveReport({ via: "worker" }), arriveReport({ via: secret }), arriveReport({ reading: true }),
    arriveReport({ found: "maybe" }), arriveReport({ visible: 1 }), arriveReport({ menu: "drawer" }),
    arriveReport({ menu: secret }), arriveReport({ home: "YES" }), arriveReport({ hist: null }),
    resultReport({ shown: "true" }), resultReport({ covered: "drawer" }), resultReport({ covered: secret }),
    resultReport({ pending: 0 }),
    // tap ids that are not eight hex characters, and none for a tap the worker made
    tapReport({ tap: "none" }), tapReport({ tap: "DEADBEEF" }), tapReport({ tap: "deadbee" }),
    tapReport({ tap: "deadbeef0" }), tapReport({ tap: "deadbeeg" }), tapReport({ tap: "deadbeef\n" }),
    tapReport({ tap: 12345678 }), tapReport({ tap: ["deadbeef"] }), tapReport({ tap: secret }),
    arriveReport({ tap: "None" }), arriveReport({ tap: "dead beef" }), arriveReport({ tap: "" }),
    arriveReport({ tap: secret }), resultReport({ tap: "deadbeef\n" }), resultReport({ tap: null }),
    // boxes that are not a card's id
    tapReport({ box: "m 7" }), tapReport({ box: "Quarterly plan" }), tapReport({ box: "9".repeat(33) }),
    tapReport({ box: "m101\n" }), tapReport({ box: 101 }), tapReport({ box: null }), tapReport({ box: secret }),
    arriveReport({ box: "<b>m1</b>" }), resultReport({ box: "../m1" }), resultReport({ box: "m1." }),
    // numbers out of range or not whole
    tapReport({ windows: -1 }), tapReport({ windows: 1001 }), tapReport({ windows: 1.5 }),
    tapReport({ windows: "1" }), tapReport({ windows: true }), tapReport({ ms: -1 }), tapReport({ ms: 600001 }),
    tapReport({ ms: 1.5 }), tapReport({ ms: "12" }), tapReport({ ms: null }), tapReport({ age: -1 }),
    tapReport({ age: 7776001 }), tapReport({ age: 0.5 }), tapReport({ age: "90" }), tapReport({ age: null }),
  ];
  for (const one of bad) {
    const refused = await send(phone([one]));
    assert.equal(refused.status, 400, JSON.stringify(one));
    assert.equal(refused.body.error, "bad notification report");
  }
  // one good report beside one bad one stores neither
  assert.equal((await send(phone([tapReport(), tapReport({ tap: secret })]))).status, 400);
  assert.equal((await send(phone([arriveReport(), resultReport({ covered: secret })]))).status, 400);
  // only the phone page speaks of taps
  for (const page of ["board", "page"]) {
    for (const one of [tapReport(), arriveReport(), resultReport()]) {
      assert.equal((await send({ page, reports: [one] })).status, 400, `${page} ${one.kind}`);
    }
  }
  // the window this came from has to be what a page sends, as for the others
  assert.equal((await send({ ...phone([tapReport()]), client: "somewhere" })).status, 400);
  assert.equal((await send({ ...phone([tapReport()]), window: "not-a-window-id" })).status, 400);
  assert.equal((await reports()).length, before, "a refused batch wrote something");
});

test("what the worker really sends for a tap is what the route takes, line for line", async () => {
  await reportsSince();
  const harness = await loadWorker({ random: [0xca, 0xfe, 0xf0, 0x0d] });
  const answers = [];
  harness.board.log = async body => {
    const answer = await send({ client: "phone", window: WINDOW, ...body });
    answers.push(answer);
    return { ok: answer.status === 200, status: answer.status };
  };
  const posted = [];
  harness.windows.all = async () => [{
    url: "https://board.test/m", visibilityState: "hidden", focused: false, focus: async () => {}, postMessage: message => posted.push(message),
  }];
  await harness.click("m12", { title: "Private card title", data: { box: "m12", shown: harness.clock.now - 7000 } });
  harness.windows.all = async () => [];
  harness.windows.open = async () => ({});
  await harness.click("m12", { title: "Private card title", data: { box: "m12", shown: harness.clock.now - 7000 } });
  harness.windows.open = async () => { throw new Error("not allowed"); };
  await assert.rejects(harness.click("Private card title"), /not allowed/);

  assert.deepEqual(answers.map(answer => answer.status), [200, 200, 200], "the board refused what the worker sent");
  assert.deepEqual(harness.idb.rows(), []);
  const fresh = await reportsSince();
  assert.deepEqual(fresh.filter(line => line.kind === "notifytap").map(line => [line.kind, line.box, line.tap, line.route, line.focus, line.opened, line.age]), [
    ["notifytap", "m12", "cafef00d", "message", "ok", undefined, 7],
    ["notifytap", "m12", "cafef00d", "open", "none", "client", 7],
    ["notifytap", undefined, "cafef00d", "open", "none", "rejected", undefined],
  ]);
  assert.ok(!JSON.stringify(fresh).includes("Private card title"), "a title reached the client file");
});

test("taps have a cap of ten a minute for each kind, and what it drops is counted", async () => {
  await reportsSince();
  const all = await reports();
  const kept = kind => all.filter(line => line.kind === kind).length;
  const room = kind => 10 - kept(kind);

  const taps = room("notifytap");
  assert.ok(taps >= 1, "earlier tests used the whole minute");
  const first = await send(phone(Array.from({ length: taps + 2 }, () => tapReport())));
  assert.deepEqual(first.body, { ok: true, written: taps, dropped: 2 });

  const arrivals = room("notifyarrive");
  const second = await send(phone(Array.from({ length: arrivals + 3 }, () => arriveReport())));
  assert.deepEqual(second.body, { ok: true, written: arrivals, dropped: 3 }, "a kind shared the cap of another");

  const results = room("notifyresult");
  const third = await send(phone(Array.from({ length: results + 1 }, () => resultReport())));
  assert.deepEqual(third.body, { ok: true, written: results, dropped: 1 });

  const notices = (await reportsSince()).filter(line => line.kind === "dropped");
  assert.deepEqual(notices.map(line => [line.report, line.dropped]),
    [["notifytap", 2], ["notifyarrive", 3], ["notifyresult", 1]]);
});

const receivedReport = (over = {}) => ({ kind: "notifytapready", stage: "received", tap: "deadbeef", box: "m101",
  at: 1_800_000_000_000, worker: "facilitator-m-9", ...over });
const readyReport = (over = {}) => receivedReport({ stage: "ready", windows: 1, visibility: "visible", focused: "yes", ...over });

test("early records preserve click time and accept only stage-specific fields", async () => {
  await reportsSince();
  const input = [receivedReport(), readyReport(), readyReport({ box: "", windows: 0, visibility: "none", focused: "none" })];
  const answer = await send(phone(input));
  assert.deepEqual(answer, { status: 200, body: { ok: true, written: 3, dropped: 0 } });
  const fresh = await reportsSince();
  assert.deepEqual(fresh, input.map(({ box, ...report }, i) => ({
    ts: fresh[i].ts, level: "info", page: "phone", client: "phone", window: WINDOW,
    ...report, ...(box ? { box } : {}),
  })));
  assert.ok(fresh.every(row => row.at === 1_800_000_000_000), "upload time replaced click time");
});

test("early records reject missing fields, unknown fields, values and inconsistent window state", async () => {
  const count = (await reports()).length;
  const bad = [
    ...["title", "message", "key", "endpoint", "url", "n", "ago", "route", "ms"].map(name => readyReport({ [name]: "private" })),
    ...Object.keys(receivedReport()).filter(name => name !== "kind").map(name => without(receivedReport(), name)),
    ...["windows", "visibility", "focused"].map(name => without(readyReport(), name)),
    receivedReport({ stage: "started" }), receivedReport({ stage: null }),
    receivedReport({ windows: 0 }), receivedReport({ visibility: "none" }), receivedReport({ focused: "none" }),
    readyReport({ visibility: "prerender" }), readyReport({ visibility: true }), readyReport({ focused: true }),
    readyReport({ focused: "maybe" }), readyReport({ visibility: "none" }), readyReport({ focused: "none" }),
    readyReport({ windows: 0 }), readyReport({ windows: -1 }), readyReport({ windows: 1001 }),
    readyReport({ windows: true }), readyReport({ windows: "1" }), readyReport({ windows: 0.5 }),
    ...[-1, 10000000000001, 0.5, "1800000000000", true, null].map(at => receivedReport({ at })),
    ...["", "none", "deadbeef\n", "DEADBEEF", "https://private.test", 1234].map(tap => receivedReport({ tap })),
    ...["m1\n", "m1\r", "private", "9".repeat(33), null, 101].map(box => receivedReport({ box })),
    ...["", "x".repeat(65), "facilitator-m-9\n", "https://private.test", null].map(worker => receivedReport({ worker })),
  ];
  for (const row of bad) {
    assert.equal((await send(phone([row]))).status, 400, JSON.stringify(row));
  }
  assert.equal((await send(phone([receivedReport(), readyReport({ title: "private" })]))).status, 400);
  for (const page of ["board", "page"]) assert.equal((await send({ page, reports: [receivedReport()] })).status, 400);
  assert.equal((await reports()).length, count, "refused reports reached the log");
});

test("both early stages share the new kind's ten-per-minute cap across windows", async () => {
  await reportsSince();
  const count = (await reports()).filter(row => row.kind === "notifytapready").length;
  const room = 10 - count;
  assert.equal(room, 1, "earlier valid reports did not arrive exactly once");
  const batch = phone(Array.from({ length: room + 2 }, (_, i) => i % 2 ? readyReport() : receivedReport()));
  batch.window = "fedcba9876543210";
  assert.deepEqual((await send(batch)).body, { ok: true, written: room, dropped: 2 });
  const fresh = await reportsSince();
  assert.deepEqual(fresh.filter(row => row.kind === "dropped").map(row => [row.report, row.dropped]), [["notifytapready", 2]]);
});
