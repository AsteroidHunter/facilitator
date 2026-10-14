// Quick notes are hidden in this version. The server answers 404 on every quick note
// route, the same as on any unknown route; /state and /m/state carry no quicknotes; a
// state save carries the stored list through byte for byte, so the notes come back
// unchanged when QUICK_NOTES_ON is turned on; and no page has a way in (no corner
// peek, no card chip, no overlay, nothing restored from browser storage).
// The notes are made with the feature on, in a copy of the server, and the hidden
// server is then started on the same state.json. Every card and note is invented.
const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { spawn } = require("node:child_process");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { launch } = require("./resp-harness.cjs");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const VIEW = { width: 1512, height: 982 };
const PHONE = { width: 390, height: 844 };
const FIRST = "Crème brûlée, 3 jars\n\ttabbed second line  \n";
const SECOND = "Ask about the lantern shed roof";

const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

// ---- the server --------------------------------------------------------------------

describe("the server", () => {
  let dir, origin, child, made, stored;
  const noteRoutes = [
    ["GET", "/quicknotes"],
    ["POST", "/quicknote/new"],
    ["POST", "/quicknote/save?id=qn1"],
    ["POST", "/quicknote/attach?id=qn1&card=0"],
    ["POST", "/quicknote/del?id=qn1"],
    ["POST", "/quicknotes"],
    ["GET", "/quicknote/new"],
    ["GET", "/quicknote/del?id=qn1"],
  ];

  async function startServer(file) {
    child = spawn(PYTHON, [path.join(dir, file)], {
      cwd: dir,
      env: { ...process.env, FACILITATOR_TEST_PORT: String(new URL(origin).port), FACILITATOR_LOG_DIR: path.join(dir, "logs") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`fixture server exited with ${child.exitCode}:\n${output}`);
      try { if ((await fetch(origin + "/state")).ok) return; } catch {}
      await wait();
    }
    throw new Error(`fixture server did not start:\n${output}`);
  }
  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
  async function call(method, route, body) {
    const response = await fetch(origin + route, { method, body: method === "POST" ? (body ?? "") : undefined });
    return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
  }
  const json = async route => JSON.parse((await call("GET", route)).text);
  const stateText = () => readFile(path.join(dir, "state.json"), "utf8");
  // the notes' own lines of state.json, from their key to the closing bracket
  function notesOf(raw) {
    const at = raw.indexOf('\n "quicknotes": [');
    assert.ok(at >= 0, "state.json has no quicknotes list");
    const end = raw.indexOf("\n ]", at);
    assert.ok(end > at, "the quicknotes list does not close");
    return raw.slice(at, end + 3);
  }
  const counterOf = raw => /\n "next_qnid": \d+/.exec(raw)[0];

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "facilitator-qnhidden-"));
    origin = `http://127.0.0.1:${await freePortPair()}`;
    const source = await readFile(path.join(ROOT, "server.py"), "utf8");
    const ported = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
    assert.notEqual(ported, source, "test server port was not patched");
    const on = ported.replace("QUICK_NOTES_ON = False", "QUICK_NOTES_ON = True");
    assert.notEqual(on, ported, "the switch was not found at False");
    await writeFile(path.join(dir, "server.py"), ported);
    await writeFile(path.join(dir, "server-on.py"), on);
    copyBridgeFiles(dir);
    await copyFile(path.join(ROOT, "m-manifest.json"), path.join(dir, "m-manifest.json"));
    await writeFile(path.join(dir, "seed.json"), JSON.stringify({
      title: "Kettle Drum",
      items: [{ id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" }],
    }));
    // two notes, one attached to the seeded card, written by the feature when it was on
    await startServer("server-on.py");
    const a = await call("POST", "/quicknote/new", FIRST);
    const b = await call("POST", "/quicknote/new?card=0", SECOND);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    made = [JSON.parse(a.text).note, JSON.parse(b.text).note];
    assert.equal(made[1].card, "0");
    await stopServer();
    stored = await stateText();
    assert.ok(notesOf(stored).includes("qn2"), "the two notes were not stored");
  });

  after(async () => {
    await stopServer();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("every quick note route answers 404 with the body any unknown route gets", async () => {
    await startServer("server.py");
    const unknown = { GET: await call("GET", "/no-such-route"), POST: await call("POST", "/no-such-route") };
    assert.equal(unknown.GET.status, 404);
    assert.deepEqual(JSON.parse(unknown.GET.text), { error: "not found" });
    for (const [method, route] of noteRoutes) {
      const got = await call(method, route, "some words");
      assert.deepEqual(got, unknown[method], `${method} ${route} answered differently from an unknown route`);
    }
  });

  test("/state and /m/state carry no quicknotes", async () => {
    for (const route of ["/state", "/m/state"]) {
      const raw = (await call("GET", route)).text;
      assert.ok(!("quicknotes" in JSON.parse(raw)), `${route} has a quicknotes key`);
      assert.ok(!raw.includes("qn1") && !raw.includes("lantern shed"), `${route} carries a note`);
    }
  });

  test("a save keeps the stored quicknotes list byte for byte, even with the card it names closed", async () => {
    const before = await json("/state");
    assert.equal((await call("POST", "/close?box=0")).status, 200, "the card was not closed");
    assert.equal((await call("POST", "/create?owner=facilitator", "Rope ladder, second rung")).status, 200);
    assert.ok((await json("/state")).rev > before.rev, "no save happened");
    await stopServer();
    const after = await stateText();
    assert.notEqual(after, stored, "state.json was not written");
    assert.equal(notesOf(after), notesOf(stored), "the quicknotes list changed");
    assert.equal(counterOf(after), counterOf(stored), "the note counter changed");
    assert.equal(JSON.parse(after).boxes.some(box => box.id === "0"), false, "the card was not removed");
  });

  test("turning the switch back on brings every route and the notes back unchanged", async () => {
    await startServer("server-on.py");
    const listed = await json("/quicknotes");
    assert.deepEqual(listed.notes, made);
    assert.equal(listed.notes[0].text, FIRST);
    const state = await json("/state");
    assert.deepEqual(state.quicknotes.map(note => note.id), ["qn1", "qn2"]);
    assert.equal((await call("POST", "/quicknote/new", "one more")).status, 200);
  });
});

// ---- the pages ---------------------------------------------------------------------

describe("the pages", () => {
  let fx;
  before(async () => { fx = await launch(); });
  after(async () => { if (fx) await fx.stop(); });

  // the page's own part of the quick note, in its markup, its styles and its script
  const PAGE_TRACES = [/qnpeek/, /qnchip/, /syncQuickNoteChip\(/, /quickNoteOverlay\(/, /quickNotesByCard\(/, /\/quicknote/];

  const entryPoints = page => page.evaluate(() => ({
    peek: document.querySelectorAll(".qnpeek, .qnchip").length,
    overlay: document.querySelectorAll(".qn-veil:not(.sp-veil), .qn-card, .qn-text").length,
    open: document.querySelectorAll(".qn-veil.open:not(.sp-veil)").length,
    wiring: [typeof quickNote, typeof qnOpen, typeof qnPeek],
    quicknotes: typeof lastState === "undefined" || !lastState ? null : "quicknotes" in lastState,
  }));

  test("no page's markup or script carries a way into the quick note", async () => {
    for (const route of ["/", "/m", "/page"]) {
      const html = await (await fetch(fx.origin + route)).text();
      for (const trace of PAGE_TRACES) assert.ok(!trace.test(html), `${route} still has ${trace}`);
    }
  });

  test("the Mac board has no peek in its corner, no chip, no overlay, and a stored note id opens nothing", async () => {
    const { context, page } = await fx.openBoard({ "quicknote.current": "qn1" }, VIEW);
    try {
      await page.mouse.move(1400, 900);
      await page.mouse.move(VIEW.width - 1, VIEW.height - 1);
      await wait(700);
      const found = await entryPoints(page);
      assert.equal(found.peek, 0, "a peek or a chip is on the board");
      assert.equal(found.overlay, 0, "the quick note's overlay is on the board");
      assert.equal(found.open, 0, "a stored note id opened the quick note");
      assert.deepEqual(found.wiring, ["undefined", "undefined", "undefined"], "the board still wires the quick note");
      assert.equal(found.quicknotes, false, "the board was given quick notes");
      const corner = await page.evaluate(w => document.elementsFromPoint(w.width - 2, w.height - 2)
        .map(el => String(el.className)).filter(c => /qn/.test(c)), VIEW);
      assert.deepEqual(corner, [], "something of the quick note is under the pointer in the corner");
      await page.keyboard.press("Escape");
      assert.equal((await entryPoints(page)).open, 0);
    } finally { await context.close(); }
  });

  test("the phone page and the typed page have no way into the quick note", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      await page.setViewport(PHONE);
      for (const route of ["/m", "/page?mock=1"]) {
        await page.goto(fx.origin + route, { waitUntil: "load" });
        await wait(700);
        await page.mouse.move(PHONE.width - 1, PHONE.height - 1);
        await wait(300);
        const found = await page.evaluate(() => ({
          peek: document.querySelectorAll(".qnpeek, .qnchip").length,
          overlay: document.querySelectorAll(".qn-veil:not(.sp-veil), .qn-card, .qn-text").length,
        }));
        assert.deepEqual(found, { peek: 0, overlay: 0 }, route);
      }
    } finally { await context.close(); }
  });
});
