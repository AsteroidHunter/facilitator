// All pages belong to invented fixtures in agent-profile Chrome. Targets are
// created in the background and are never activated.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
before(async () => {
  await fs.mkdir(EVIDENCE, { recursive: true });
  browser = await puppeteer.connect({ browserURL: "http://localhost:9222" });
});
after(async () => { if (browser) await browser.disconnect(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(25); }
  throw new Error("fixture condition timed out");
}
async function fixture(t) {
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
  const source = await fs.readFile(path.join(ROOT, "server.py"), "utf8");
  await fs.writeFile(path.join(dir, "server.py"), source.replace("PORT = 8877", `PORT = ${port}`));
  for (const name of ["m.html", "card-logic.js", "card-report.js", "card-markdown.js", "card-tokens.css",
                      "compose-format.js", "cm-markdown.js", "m-sw.js", "m-manifest.json"])
    await fs.copyFile(path.join(ROOT, name), path.join(dir, name));
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
  let telemetry = "pass";
  page.on("request", request => {
    if (!request.url().startsWith(origin)) { request.abort().catch(() => {}); return; }
    const route = new URL(request.url()).pathname;
    if (route === "/clientlog") {
      requests.push(JSON.parse(request.postData()));
      if (telemetry === "fail") { request.abort().catch(() => {}); return; }
      if (telemetry === "dropped") { request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, written: 0, dropped: 1 }) }).catch(() => {}); return; }
    }
    request.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument(() => {
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
  return { page, origin, requests, errors, readLog, telemetry: value => { telemetry = value; } };
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
  assert.ok(saved.events.length <= 40);
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
        showMenu(i % 2 ? settings : drawer);
        hideMenu(i % 2 ? settings : drawer);
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
    select("m3"); showMenu(drawer); hideMenu(drawer);
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
