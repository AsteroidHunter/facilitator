// All pages belong to invented fixtures in agent-profile Chrome. Targets are
// created in the background and are never activated.
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { before, after, test } = require("node:test");
const puppeteer = require("puppeteer-core");
const ROOT = path.resolve(__dirname, "..");
const EVIDENCE = process.env.FACILITATOR_INCIDENT_EVIDENCE || path.join(os.tmpdir(), "facilitator-incident-browser");
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
let browser;
let ownedBrowser = false;
before(async () => {
  await fs.mkdir(EVIDENCE, { recursive: true });
  const executablePath = process.env.FACILITATOR_BROWSER_EXECUTABLE;
  if (executablePath) {
    ownedBrowser = true;
    browser = await puppeteer.launch({ executablePath, headless: true,
      args: ["--no-first-run", "--no-default-browser-check"] });
  } else browser = await puppeteer.connect({ browserURL: "http://localhost:9222" });
});
after(async () => { if (browser) await (ownedBrowser ? browser.close() : browser.disconnect()); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function shiftEnter(page) {
  await page.keyboard.down("Shift");
  try { await page.keyboard.press("Enter"); }
  finally { await page.keyboard.up("Shift"); }
}
async function wait(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(25); }
  throw new Error("fixture condition timed out");
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-incident-browser-"));
  let child, context, page;
  const errors = [], requests = [];
  t.after(async () => {
    const state = page && !page.isClosed() ? await page.evaluate(() => ({
      status: document.getElementById("diagnosticstatus")?.textContent,
      toast: document.getElementById("diagnostictoast")?.textContent,
      hidden: document.hidden, focus: document.hasFocus(), selected: selectedId,
      windowErrors: window.fixtureWindowErrors,
    })).catch(() => null) : null;
    await fs.writeFile(path.join(EVIDENCE, t.name.replace(/[^a-z0-9]/gi, "_").slice(0, 120) + ".json"), JSON.stringify({ state, requests, errors }, null, 2));
    if (page && !page.isClosed()) await page.close();
    if (context) await context.close();
    if (child && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let source = await fs.readFile(path.join(ROOT, "server.py"), "utf8");
  if (options.schema === 2)
    source = execFileSync("git", ["show", "f85c7ab:server.py"], { cwd: ROOT, encoding: "utf8" });
  if (options.schema === 3)
    source = execFileSync("git", ["show", "b67554e:server.py"], { cwd: ROOT, encoding: "utf8" });
  const patched = source.replace("PORT = 8877", `PORT = ${port}`)
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
             'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"');
  assert.match(patched, /TAILSCALE_APP = "\/facilitator-test\/no-tailscale-app"/);
  await fs.writeFile(path.join(dir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(dir, "server.py")));
  for (const name of ["m.html", "card-logic.js", "card-report.js", "card-markdown.js", "card-tokens.css",
                      "compose-format.js", "cm-markdown.js", "m-sw.js", "m-manifest.json"]) {
    if (name === "card-report.js") {
      const reporter = await fs.readFile(path.join(ROOT, name), "utf8");
      assert.equal(reporter.split("const POST_MS = 20000").length, 2);
      await fs.writeFile(path.join(dir, name), reporter.replace("const POST_MS = 20000", "const POST_MS = 75"));
      continue;
    }
    if (name !== "m.html") { await fs.copyFile(path.join(ROOT, name), path.join(dir, name)); continue; }
    const phone = await fs.readFile(path.join(ROOT, name), "utf8");
    const marker = "const createDiagnostics = new Map();         // transient timing tokens; never persisted";
    assert.equal(phone.split(marker).length, 2, "create diagnostic test marker changed");
    await fs.writeFile(path.join(dir, name), phone.replace(marker,
      marker + "\nwindow.__fixtureCreateDiagnosticCount = () => createDiagnostics.size;"));
  }
  await fs.cp(path.join(ROOT, "assets"), path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "seed.json"), JSON.stringify({ title: "Diagnostic fixture", items: [
    { id: "0", bucket: "meta", title: "Invented standing card", owner: "facilitator" },
    ...Array.from({ length: 20 }, (_, i) => ({ id: "m" + (i + 1), bucket: "meta", owner: "facilitator", title: "Invented card " + (i + 1) })),
  ] }));
  const logs = path.join(dir, "logs");
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(dir, "server.py")], {
    cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: logs }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", part => { output += part; });
  await wait(async () => {
    if (child.exitCode !== null) throw new Error(output);
    return fetch(origin + "/state").then(r => r.ok).catch(() => false);
  });
  context = await browser.createBrowserContext();
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true, browserContextId: context.id });
  const target = await browser.waitForTarget(t => t._targetId === targetId);
  page = await target.page();
  await cdp.detach();
  await page.setViewport(PHONE);
  page.on("pageerror", e => errors.push(e.message));
  await page.setRequestInterception(true);
  let telemetry = "pass", stateLatency = 0;
  page.on("request", request => {
    if (!request.url().startsWith(origin)) { request.abort().catch(() => {}); return; }
    const route = new URL(request.url()).pathname;
    if (route === "/clientlog") {
      requests.push(JSON.parse(request.postData()));
      if (telemetry === "fail") { request.abort().catch(() => {}); return; }
      if (telemetry === "dropped") { request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, written: 0, dropped: 1 }) }).catch(() => {}); return; }
    }
    if (route === "/m/state" && stateLatency) {
      setTimeout(() => request.continue().catch(() => {}), stateLatency);
      return;
    }
    request.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("phoneDeveloperMode", "on");
    window.fixtureWindowErrors = [];
    addEventListener("error", event => {
      if (event?.message) window.fixtureWindowErrors.push({ kind: "error", message: event.message });
    });
    addEventListener("unhandledrejection", event => {
      const reason = event?.reason;
      window.fixtureWindowErrors.push({ kind: "rejection", message: reason?.message || String(reason) });
    });
    // Stand-in dimensions for the keyboard reconciler, not a system keyboard.
    const vv = new EventTarget();
    let height, top = 0;
    Object.defineProperties(vv, {
      height: { get: () => height ?? innerHeight }, width: { get: () => innerWidth },
      offsetTop: { get: () => top }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    window.fixtureViewport = (h, t = 0) => { height = h; top = t; vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll")); };
  });
  await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!lastState, { polling: 25, timeout: 6000 });
  await page.evaluate(async () => { await pollRun; clearTimeout(pollTimer); });
  async function readLog(prefix = "client-") {
    const lines = [];
    for (const name of (await fs.readdir(logs)).sort()) if (name.startsWith(prefix)) {
      for (const line of (await fs.readFile(path.join(logs, name), "utf8")).trim().split("\n")) if (line) lines.push(JSON.parse(line));
    }
    return lines;
  }
  return { page, origin, requests, errors, readLog,
    telemetry: value => { telemetry = value; }, stateLatency: value => { stateLatency = value; } };
}

test("Settings saves a real bounded client log with rendered feedback and existing operation correlation", async t => {
  const f = await fixture(t), { page } = f;
  const state = await page.evaluate(() => ({ hidden: document.hidden, visibility: document.visibilityState, focus: document.hasFocus() }));
  console.log("Agent Chrome page state: " + JSON.stringify(state));
  await page.evaluate(() => {
    select("m1"); els.m1.ta.value = "Invented message that diagnostics must exclude";
    els.m1.tick(); doSend("m1");
  });
  await page.waitForFunction(() => ops.length === 0, { polling: 25 });
  await page.evaluate(() => { clearTimeout(autoNext); clearTimeout(pollTimer); showMenu(settings); });
  await delay(700);
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent === "Diagnostic history saved on the Mac.", { polling: 25 });
  const reports = await f.readLog();
  const saved = reports.find(r => r.kind === "incident" && r.reason === "manual");
  assert.ok(saved, JSON.stringify(reports));
  assert.ok(saved.events.length <= 128);
  assert.equal(saved.events.at(-1).source, "settings");
  const operation = saved.events.find(e => e.outcome === "minted" && e.op);
  assert.ok(operation);
  assert.ok(saved.events.some(e => e.outcome === "applied" && e.op === operation.op));
  const server = await f.readLog("server-");
  assert.ok(server.some(e => e.op === operation.op), "client operation did not join to its server event");
  assert.doesNotMatch(JSON.stringify(saved), /Invented|message that|token|textarea|https?:/);
  assert.ok(f.requests.every(b => Buffer.byteLength(JSON.stringify(b)) <= 16 * 1024));
  await page.screenshot({ path: path.join(EVIDENCE, "settings-saved.png") });
  await fs.writeFile(path.join(EVIDENCE, "manual-saved.json"), JSON.stringify({ state, saved, errors: f.errors }, null, 2));
  assert.deepEqual(f.errors, []);
});

test("new phone page saves a compatible incident to the actual pre-v3 receiver", async t => {
  const f = await fixture(t, { schema: 2 });
  await f.page.evaluate(() => {
    phoneHistory.capability(3);
    phoneHistory.note("input", { action: "response-scroll", part: "touch" });
    phoneHistory.note("phase", { action: "state", part: "json", bytes: 400 });
    phoneHistory.note("render", { changed: true, bytes: 400, action: "state" });
    phoneHistory.capability(2);
    document.getElementById("savediagnostic").click();
  });
  await f.page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent ===
    "Diagnostic history saved on the Mac.", { polling: 25 });
  const saved = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.equal(saved.v, 2);
  assert.ok(saved.events.length <= 40);
  assert.equal(saved.events.some(e => e.event === "input"), false);
  assert.equal(saved.events.some(e => ["bytes", "changed", "action", "part"].some(key => key in e)), false);
  assert.equal("worker" in saved, false);
  await f.page.evaluate(() => {
    phoneHistory.capability(3);
    phoneHistory.note("frame", { ms: 750 });
    phoneHistory.note("stage", { stage: "title-input", editorReady: true });
    phoneHistory.capability(undefined);
    document.getElementById("savediagnostic").click();
  });
  await wait(async () => (await f.readLog()).filter(r => r.kind === "incident" && r.reason === "manual").length === 2);
  const second = (await f.readLog()).filter(r => r.kind === "incident" && r.reason === "manual")[1];
  assert.equal(second.v, 1);
  assert.equal(second.events.some(e => ["input", "frame", "phase", "stage"].includes(e.event)), false);
  assert.equal(second.events.some(e => ["bytes", "changed", "action", "part", "editorReady"].some(key => key in e)), false);
  assert.deepEqual(f.errors, []);
});

test("formatted Enter records capture, editor decision, send result, Shift and composition without text", async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => { select("m1"); fixtureViewport(innerHeight); ComposeFormat.setEnabled(true); });
  await page.waitForFunction(() => !!els.m1?.field?.view, { polling:25 });
  await page.evaluate(() => { els.m1.ta.focus(); fixtureViewport(innerHeight - 60); });
  await page.keyboard.type("Private formatted draft marker");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !els.m1.ta.value, { polling:25 });
  await page.keyboard.type("Second private draft marker");
  await shiftEnter(page);
  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key:"Enter", code:"Enter", isComposing:true,
      bubbles:true, cancelable:true });
    Object.defineProperty(event, "keyCode", { value:229 });
    els.m1.field.focusEl().dispatchEvent(event);
    const unrelated = new KeyboardEvent("keydown", { key:"Unidentified", code:"KeyA", isComposing:true,
      bubbles:true, cancelable:true });
    Object.defineProperty(unrelated, "keyCode", { value:229 });
    els.m1.field.focusEl().dispatchEvent(unrelated);
  });
  await page.evaluate(() => fixtureViewport(innerHeight - 336));
  await page.keyboard.press("Enter");
  assert.match(await page.evaluate(() => els.m1.ta.value), /\n$/);
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent ===
    "Diagnostic history saved on the Mac.", { polling:25 });
  const saved = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.equal(saved.v, 5);
  const entered = saved.events.filter(e => e.event === "enter");
  assert.ok(entered.some(e => e.step === "capture" && e.kb === false && e.draft &&
    e.base - e.vh >= 56 && e.base - e.vh <= 64), JSON.stringify(entered));
  assert.ok(entered.some(e => e.step === "format" && e.branch === "send"));
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "send" && e.minted === true && e.draft === true));
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "shift" && e.shift === true));
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "composition" && e.keyCode === 229));
  assert.ok(entered.filter(e => e.keyCode === 229).every(e => e.key === "Enter"),
    "unrelated IME keydowns entered the Enter-only history");
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "keyboard" && e.kb === true));
  assert.ok(entered.some(e => e.step === "format" && e.branch === "editor" && e.kb === true));
  assert.ok(entered.some(e => e.step === "editor" && e.branch === "row-line" && e.kb === true));
  assert.ok(entered.every(e => !Object.hasOwn(e, "box") && !Object.hasOwn(e, "op")));
  assert.doesNotMatch(JSON.stringify(saved), /Private formatted|Second private|marker/);
  assert.ok(f.requests.every(b => Buffer.byteLength(JSON.stringify(b)) <= 16 * 1024));
  assert.deepEqual(f.errors, []);
});

test("plain software Return records line insertion, then hardware Enter sends", async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => { select("m1"); fixtureViewport(innerHeight); ComposeFormat.setEnabled(false); });
  await page.waitForFunction(() => !els.m1?.field?.view, { polling:25 });
  await page.evaluate(() => { els.m1.ta.focus(); fixtureViewport(innerHeight - 336); });
  await page.keyboard.type("Private plain draft marker");
  await page.keyboard.press("Enter");
  assert.match(await page.evaluate(() => els.m1.ta.value), /\n$/);
  await shiftEnter(page);
  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key:"Enter", code:"Enter", isComposing:true,
      bubbles:true, cancelable:true });
    Object.defineProperty(event, "keyCode", { value:229 });
    els.m1.ta.dispatchEvent(event);
  });
  await page.evaluate(() => fixtureViewport(innerHeight - 60));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !els.m1.ta.value, { polling:25 });
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent ===
    "Diagnostic history saved on the Mac.", { polling:25 });
  const saved = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.equal(saved.v, 5);
  const entered = saved.events.filter(e => e.event === "enter");
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "keyboard" && e.kb === true), JSON.stringify(entered));
  assert.ok(entered.some(e => e.step === "beforeinput" && e.branch === "line-intent"));
  assert.ok(entered.some(e => e.step === "input" && e.branch === "line-applied"));
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "shift" && e.shift === true));
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "composition" && e.keyCode === 229));
  assert.ok(entered.some(e => e.step === "handler" && e.branch === "send" && e.minted === true && e.kb === false));
  assert.doesNotMatch(JSON.stringify(saved), /Private plain|marker/);
  assert.deepEqual(f.errors, []);
});

test("actual schema-3 receiver saves ordinary history and explains omitted Enter detail", async t => {
  const f = await fixture(t, { schema: 3 }), { page } = f;
  assert.equal(await page.evaluate(() => phoneHistory.version()), 3);
  await page.evaluate(() => { select("m1"); ComposeFormat.setEnabled(false); els.m1.ta.focus(); });
  await page.keyboard.type("Private old receiver draft");
  await shiftEnter(page);
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent.startsWith(
    "History saved, but Enter or scroll details need the updated server."), { polling:25 });
  const first = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.equal(first.v, 3);
  assert.equal(first.events.some(e => e.event === "enter"), false);
  assert.doesNotMatch(JSON.stringify(first), /Private old receiver/);
  assert.equal(f.requests.filter(b => b.reports[0].reason === "manual").length, 1);
  await page.evaluate(() => { phoneHistory.capability(4); document.getElementById("savediagnostic").click(); });
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent.startsWith(
    "History saved, but Enter or scroll details need the updated server."), { polling:25 });
  const attempts = f.requests.filter(b => b.reports[0].reason === "manual");
  assert.equal(attempts.length, 3, "stale capability did not retry the strict v3 receiver");
  assert.deepEqual(attempts.slice(-2).map(b => b.reports[0].v), [4,3]);
  assert.equal((await f.readLog()).filter(r => r.kind === "incident" && r.reason === "manual").length, 2);
  assert.deepEqual(f.errors, []);
});

test("stale schema-4 fallback counts each POST and retains an exhausted save", async t => {
  const f = await fixture(t, { schema: 3 }), { page } = f;
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => document.getElementById("savediagnostic").click());
    await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent ===
      "Diagnostic history saved on the Mac.", { polling:25 });
  }
  await page.evaluate(() => {
    phoneHistory.capability(4);
    phoneHistory.note("enter", { step:"capture", branch:"seen", base:812, inner:764,
      vh:696, vt:0, scale:100, kb:true, target:"textarea", focus:"textarea", draft:true,
      key:"Enter", code:"Enter", keyCode:13, shift:false, repeat:false,
      composing:false, prevented:false });
    document.getElementById("savediagnostic").click();
  });
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent.startsWith(
    "Too many saves this minute."), { polling:25 });
  const attempts = f.requests.filter(b => b.reports[0].reason === "manual");
  assert.equal(attempts.length, 4, "compatibility sent an unbudgeted fifth POST");
  assert.deepEqual(attempts.map(b => b.reports[0].v), [3,3,3,4]);
  assert.equal((await f.readLog()).filter(r => r.kind === "incident" && r.reason === "manual").length, 3);
  assert.equal(await page.evaluate(() => document.getElementById("savediagnostic").textContent),
    "Retry diagnostic save");
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => !document.getElementById("savediagnostic").disabled, { polling:25 });
  assert.equal(f.requests.filter(b => b.reports[0].reason === "manual").length, 4,
    "an immediate retry escaped the attempt cap");
  assert.deepEqual(f.errors, []);
});

test("Enter pressure keeps recent bounded evidence and never accepts draft text", async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => {
    for (let n = 0; n < 200; n++) phoneHistory.note("enter", {
      step:"capture", branch:"seen", base:812, inner:764, vh:696, vt:0, scale:100,
      kb:true, target:"textarea", focus:"textarea", draft:true,
      key:"Enter", code:"Enter", keyCode:13, shift:false, repeat:false,
      composing:false, prevented:false, text:"Private pressure draft marker",
    });
    document.getElementById("savediagnostic").click();
  });
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent ===
    "Diagnostic history saved on the Mac.", { polling:25 });
  const saved = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.equal(saved.v, 5);
  assert.ok(saved.events.some(e => e.event === "enter" && e.step === "capture"));
  assert.ok(saved.lost > 0, "pressure did not report evictions");
  assert.ok(saved.events.length <= 128);
  assert.ok(f.requests.every(b => Buffer.byteLength(JSON.stringify(b)) <= 12 * 1024));
  assert.doesNotMatch(JSON.stringify(saved), /Private pressure|draft marker|"text"/);
  assert.deepEqual(f.errors, []);
});

test("response scrolling and drawer gestures retain frame evidence during a delayed poll", async t => {
  const f = await fixture(t), { page } = f;
  f.stateLatency(2200);
  const scrollBox = await page.evaluate(() => {
    const view = document.querySelector(".box.sel .replyview");
    view.querySelector(".reply").textContent = Array(100).fill("Invented response line for scroll testing.").join("\n");
    const rect = view.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, from: rect.bottom - 45, to: rect.top + 45,
      canScroll: view.scrollHeight > view.clientHeight };
  });
  assert.ok(scrollBox.canScroll);
  await page.evaluate(() => { clearTimeout(pollTimer); void poll(); });
  await delay(100);
  await page.touchscreen.touchStart(scrollBox.x, scrollBox.from);
  for (let step = 1; step <= 8; step++)
    await page.touchscreen.touchMove(scrollBox.x, scrollBox.from + (scrollBox.to - scrollBox.from) * step / 8);
  await page.touchscreen.touchEnd();
  await delay(250);
  // a touch at the edge above the card is the drawer's own. a swipe from the edge
  // that starts on the response is a response touch, and the drawer takes it:
  // the page records it that way since 166693d, and a finger this close to the
  // response is read as on it, so the two are driven apart
  await page.touchscreen.touchStart(6, 40);
  await page.touchscreen.touchEnd();
  await delay(100);
  await page.touchscreen.touchStart(6, 500);
  for (let x = 30; x <= 250; x += 40) await page.touchscreen.touchMove(x, 500);
  await page.touchscreen.touchEnd();
  await page.evaluate(() => { const until = performance.now() + 650; while (performance.now() < until) {} });
  await delay(2300);
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent === "Diagnostic history saved on the Mac.", { polling: 25 });
  const saved = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.ok(saved);
  assert.equal(saved.v, 5);
  assert.ok(saved.events.some(e => e.event === "input" && e.action === "response-scroll"));
  assert.ok(saved.events.some(e => e.event === "scroll" && e.phase === "end" && e.count > 0));
  assert.ok(saved.events.some(e => e.event === "input" && e.action === "drawer" && e.part === "touch"));
  assert.ok(saved.events.some(e => e.event === "input" && e.action === "response-scroll" &&
    e.part === "taken" && e.by === "drawer"), "the drawer's swipe over the response was not recorded as taken");
  assert.ok(saved.events.some(e => e.event === "request" && e.ms >= 2000));
  assert.ok(saved.events.some(e => e.event === "phase" && e.part === "fetch-headers" && e.ms >= 2000));
  assert.ok(saved.events.some(e => e.event === "frame" && e.ms >= 250) ||
    saved.events.some(e => e.event === "timer" && e.late >= 500));
  assert.doesNotMatch(JSON.stringify(saved), /Invented|response line|https?:|clientX|clientY/);
  assert.ok(f.requests.every(b => Buffer.byteLength(JSON.stringify(b)) <= 16 * 1024));
  assert.deepEqual(f.errors, []);
});

test("enabled recorder overhead is measured during render, drawer and viewport work", async t => {
  const f = await fixture(t), { page } = f;
  await delay(100);
  const incidentsBefore = f.requests.filter(batch => batch.reports.some(report => report.kind === "incident")).length;
  const measurement = await page.evaluate(() => {
    const liveTrace = tracePhone, liveEnd = endPhoneTrace;
    const quiet = () => {};
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const run = (enabled, count) => {
      tracePhone = enabled ? liveTrace : quiet;
      endPhoneTrace = enabled ? liveEnd : quiet;
      const started = performance.now();
      for (let i = 0; i < count; i++) {
        apply(lastState);
        showMenu(i % 2 ? settings : tickets);
        hideMenu(i % 2 ? settings : tickets);
        for (let n = 0; n < 6; n++) {
          fixtureViewport(844 - ((i + n) % 4) * 4, (i + n) % 2 ? 4 : 0);
          reconcile();
        }
      }
      const elapsed = performance.now() - started;
      if (enabled) liveTrace("note", "render", { rev: lastRev });
      return elapsed;
    };
    const count = 50, enabled = [], disabled = [];
    run(false, 5); run(true, 5);
    try {
      for (let round = 0; round < 11; round++) {
        if (round % 2) {
          enabled.push(run(true, count)); disabled.push(run(false, count));
        } else {
          disabled.push(run(false, count)); enabled.push(run(true, count));
        }
      }
    } finally {
      tracePhone = liveTrace; endPhoneTrace = liveEnd;
      fixtureViewport(844, 0); reconcile();
    }
    const enabledMedianMs = median(enabled), disabledMedianMs = median(disabled);
    return { count, rounds: enabled.length, enabled, disabled, enabledMedianMs, disabledMedianMs,
      addedMedianMs: enabledMedianMs - disabledMedianMs,
      addedMedianMsPerInteraction: (enabledMedianMs - disabledMedianMs) / count,
      viewportSignalsPerInteraction: 6, hidden: document.hidden, focus: document.hasFocus() };
  });
  await fs.writeFile(path.join(EVIDENCE, "overhead.json"), JSON.stringify(measurement, null, 2));
  console.log("Incident recorder overhead: " + JSON.stringify(measurement));
  assert.equal(measurement.rounds, 11);
  assert.ok(Number.isFinite(measurement.addedMedianMsPerInteraction));
  assert.ok(measurement.addedMedianMsPerInteraction < 5, JSON.stringify(measurement));
  assert.equal(f.requests.filter(batch => batch.reports.some(report => report.kind === "incident")).length, incidentsBefore,
    "ordinary interaction history was transmitted");
  assert.deepEqual(f.errors, []);
});

test("offline, rejected and failed saves preserve the noticed moment for an honest retry", async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: false }); showMenu(settings); });
  await delay(700);
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent.startsWith("Offline."), { polling: 25 });
  assert.equal(f.requests.filter(b => b.reports[0].reason === "manual").length, 0);
  await page.screenshot({ path: path.join(EVIDENCE, "settings-offline.png") });
  await page.evaluate(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
  f.telemetry("dropped");
  await page.evaluate(() => document.getElementById("savediagnostic").click());
  await page.waitForFunction(() => document.getElementById("diagnosticstatus").textContent.startsWith("Could not confirm"), { polling: 25 });
  const marked = f.requests.find(b => b.reports[0].reason === "manual").reports[0].marked;
  f.telemetry("fail");
  await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", {
    key: "M", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  })));
  await page.waitForFunction(() => !document.getElementById("savediagnostic").disabled, { polling: 25 });
  const manual = f.requests.filter(b => b.reports[0].reason === "manual");
  assert.equal(manual.length, 2, "a telemetry failure recursively reported itself");
  assert.ok(manual.every(b => b.reports[0].marked === marked));
  f.telemetry("pass");
  await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", {
    key: "M", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  })));
  await page.waitForFunction(() => document.getElementById("diagnostictoast").textContent === "Diagnostic history saved on the Mac.", { polling: 25 });
  const saved = (await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual");
  assert.equal(saved.marked, marked);
  assert.equal(saved.events.at(-1).online, false);
  assert.equal(saved.events.at(-1).source, "settings", "a shortcut retry replaced the noticed moment");
  assert.deepEqual(f.errors, []);
});

test("the shortcut preserves draft and focus; broken instrumentation cannot stop phone operations", async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => { select("m2"); els.m2.ta.value = "An invented unsent draft"; els.m2.ta.focus({ preventScroll: true }); });
  await delay(250);
  // The real browser's dispatch path, with a synthetic key event. An inactive
  // window cannot prove physical keyboard routing without taking focus.
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    key: "M", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  })));
  await page.waitForFunction(() => document.getElementById("diagnostictoast").textContent === "Diagnostic history saved on the Mac.", { polling: 25 });
  // the row answers to two shapes, the plain field and the editor the
  // typed-formatting setting puts in its place; the caret being in this card's
  // row is the thing asked about, not which element the row is made of
  assert.deepEqual(await page.evaluate(() => ({ id: selectedId, draft: els.m2.ta.value, focus: ComposeFormat.focused(els.m2.ta), menu: !!menuOut() })),
    { id: "m2", draft: "An invented unsent draft", focus: true, menu: false });
  assert.equal((await f.readLog()).find(r => r.kind === "incident" && r.reason === "manual").events.at(-1).source, "shortcut");
  await page.evaluate(() => {
    window.phoneHistory = new Proxy({}, { get() { throw new Error("broken recorder fixture"); } });
    select("m3"); showMenu(tickets); hideMenu(tickets);
    els.m3.ta.value = "Invented send despite diagnostics"; doSend("m3");
    fixtureViewport(500, 8); fixtureViewport(844);
  });
  await page.waitForFunction(() => ops.length === 0, { polling: 25 });
  await page.evaluate(() => { clearTimeout(autoNext); createCard(); });
  await page.waitForFunction(() => !pendingCreate(), { polling: 25 });
  const state = await (await fetch(f.origin + "/state")).json();
  assert.ok(state.boxes.find(b => b.id === "m3").pendingTexts.includes("Invented send despite diagnostics"));
  assert.ok(state.boxes.length > 21);
  assert.deepEqual(f.errors, []);
});

test("new-card diagnostics separate insertion from selection readiness", async t => {
  const f = await fixture(t), { page } = f;
  const before = await page.evaluate(() => {
    // The fixture's standing m1 would collide with the server's first minted
    // meta id. Remove only that invented client card so the create path must
    // attach a fresh DOM/editor for the returned m1. The page builds only the
    // cards near the one on show, so m1 may not be built at all.
    select("m2");
    if (els.m1){ els.m1.field?.detach(); els.m1.box.remove(); delete els.m1; }
    lastState.boxes = lastState.boxes.filter(box => box.id !== "m1");
    return { count:document.querySelectorAll("article.box").length, selected:selectedId };
  });
  await page.evaluate(() => createCard());
  await wait(() => page.evaluate(() => !pendingCreate()), 10000);
  const created = await page.evaluate(() => ({ count:document.querySelectorAll("article.box").length,
    editing:!!document.querySelector("article.box.sel .title")?.isContentEditable }));
  assert.equal(created.editing, true);
  assert.notEqual(await page.evaluate(() => selectedId), before.selected);
  await page.locator("article.box.sel .title").fill("Invented title excluded from diagnostics");
  assert.equal((await page.evaluate(() => phoneHistory.mark("shortcut", phoneTraceState()))).status, "saved");
  await wait(async () => f.requests.some(batch => batch.reports.some(report => report.kind === "incident")));
  const saved = f.requests.flatMap(batch => batch.reports).find(report => report.kind === "incident" && report.reason === "manual");
  const insertionEnd = saved.events.findIndex(e => e.event === "stage" && e.stage === "card-insertion" && e.phase === "end");
  const selectedStart = saved.events.findIndex(e => e.event === "stage" && e.stage === "selected-ready" && e.phase === "start");
  const selectedEnd = saved.events.find(e => e.event === "stage" && e.stage === "selected-ready" && e.phase === "end");
  assert.ok(insertionEnd >= 0 && selectedStart > insertionEnd);
  assert.equal(saved.events.some(e => e.event === "stage" && e.stage === "editor-init" && e.phase === "end" && e.editorReady), true);
  assert.deepEqual({ shown:selectedEnd.shown, editing:selectedEnd.editing, inputReady:selectedEnd.inputReady, paneBlank:selectedEnd.paneBlank },
    { shown:true, editing:true, inputReady:true, paneBlank:false });
  assert.equal(saved.events.some(e => e.event === "stage" && e.stage === "title-input"), true);
  assert.doesNotMatch(JSON.stringify(saved), /Invented title|excluded from diagnostics/);
});

test("a thrown create landing releases its bounded diagnostic record", async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => {
    window.__fixtureOriginalLandCreate = landCreate;
    window.landCreate = () => { throw new Error("invented landing failure"); };
    createCard();
  });
  await page.waitForFunction(() => !ops.some(op => op.kind === "create") && !opWorkers.create, { polling: 25 });
  assert.deepEqual(await page.evaluate(() => ({ traces:__fixtureCreateDiagnosticCount(), pending:!!pendingCreate(), worker:!!opWorkers.create })),
    { traces:0, pending:false, worker:false });
});
