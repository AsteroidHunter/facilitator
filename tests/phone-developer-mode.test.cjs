// The page's mode, settings builder and save handler with the real recorder.
// No browser, phone, server or network is used. Old-source paths prove regressions.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { fixture } = require("./phone-history-fixture.cjs");
const html = readFileSync(process.env.PHONE_DEVELOPER_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");
const logic = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");
const between = (text, first, last) => {
  const start = text.indexOf(first), end = text.indexOf(last, start);
  assert.ok(start >= 0 && end > start, `missing ${first}`);
  return text.slice(start, end);
};
function element(tag = "div", classes = "", textContent = "") {
  const names = new Set(classes.split(" ")), listeners = {};
  return {
    tag, textContent, dataset: {}, childNodes: [], disabled: false,
    classList: { contains: name => names.has(name), add: name => names.add(name),
      toggle(name, on) { if (on) names.add(name); else names.delete(name); } },
    append(...nodes) { this.childNodes.push(...nodes); },
    appendChild(node) { this.append(node); }, replaceChildren(...nodes) { this.childNodes = nodes; },
    setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, remove() {}, focus() {},
    addEventListener(name, fn) { listeners[name] = fn; }, click() { return listeners.click?.(); },
  };
}
function phone(store = new Map()) {
  const nodes = Object.fromEntries(["homeversion", "savediagnostic", "diagnosticstatus", "diagnostictoast", "setpage"]
    .map(id => [id, element()]));
  nodes.savediagnostic.textContent = "Save diagnostic history";
  const groups = ["editor", "notifications", "diagnostics"].map(id => {
    const group = element(); group.dataset = { section: id, label: id };
    if (id === "diagnostics") group.childNodes = [nodes.savediagnostic, nodes.diagnosticstatus];
    return group;
  });
  const source = element(); source.querySelectorAll = () => groups;
  const f = fixture("phone", { setup(context) {
    const body = element(); context.document.body = body; context.document.activeElement = body;
    context.document.getElementById = id => nodes[id];
    context.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
    context.h = element; context.settingsMark = () => element();
    context.phoneTraceState = () => ({ box: "m12" });
    context.source = source;
    context.createDiagnostics = new Map();
    context.innerWidth = 390; context.selectedId = "m12"; context.els = {};
    context.menuOut = () => null;
    vm.runInContext(between(html, html.includes("// Developer mode belongs")
      ? "// Developer mode belongs" : "// the phone is where a failure is hardest", "function traceFrameOpportunity"), context);
    vm.runInContext(between(logic, "function settingsPage(root, source, opts){", "\nfunction "), context);
    vm.runInContext('const settingsView = settingsPage(document.getElementById("setpage"), source, { narrow: { matches: true } });', context);
    vm.runInContext(between(html, "let noteToastTimer =", "// ---- sending and making"), context);
    vm.runInContext(between(html, "function traceFrameOpportunity", "function phoneTraceState"), context);
    vm.runInContext(between(html, "// Keep only the start, first intended move, and end of a gesture.", "// ---- the startup curtain"), context);
    vm.runInContext(between(html, 'const diagnosticButton =', '// the Notifications switch'), context);
    const diagnostic = /  diagnostic\(e\)\{([\s\S]*?)\n  \},/.exec(html);
    assert.ok(diagnostic);
    vm.runInContext(`function diagnosticShortcut(e){${diagnostic[1]}\n}`, context);
  } });
  let time = 0;
  return { ...f, nodes, store,
    runPage: code => vm.runInContext(code, f.context),
    on: () => vm.runInContext('typeof phoneDeveloperMode === "undefined" ? true : phoneDeveloperMode', f.context),
    at(ms) { time = ms; f.now(ms); },
    tap(gap = 100) { time += gap; f.now(time); nodes.homeversion.click(); },
    taps(n = 7, gap = 100) { for (let i = 0; i < n; i++) this.tap(gap); },
    key() { const event = { prevented: false, preventDefault() { this.prevented = true; } };
      f.context.diagnosticShortcut(event); return event; },
    // The real builder made both controls; the phone's CSS gates both of them.
    sectionShown() {
      for (const selector of ['#settings .sp-item[data-section="diagnostics"]', '#settings-diagnostics'])
        assert.ok(html.includes('body:not(.phone-developer-mode) ' + selector));
      assert.match(html, /#settings-diagnostics\{display:none!important\}/);
      const list = nodes.setpage.childNodes[1].childNodes[0];
      assert.ok(list.childNodes.some(item => item.dataset.section === "diagnostics"));
      return f.document.body.classList.contains("phone-developer-mode");
    },
  };
}
const incidents = batches => batches.flatMap(b => b.reports).filter(r => r.kind === "incident");

test("off by default: no section, inert shortcut and direct save, no automatic history or upload", async () => {
  const f = phone(); f.history.capability(5);
  assert.equal(f.on(), false); assert.equal(f.sectionShown(), false);
  assert.equal(f.key().prevented, false); f.nodes.savediagnostic.click();
  assert.equal(f.nodes.diagnostictoast.textContent, "");
  f.at(5000); f.history.note("send", { box: "m12" }); f.history.noScroll("m12"); f.history.freeze(3000);
  f.at(30000); await f.run(); f.hidden(true); f.fire("pagehide");
  assert.equal(f.calls.length, 0); assert.equal(f.beacons.length, 0);
  f.hidden(false); f.taps();
  const pending = f.history.mark("settings"); f.at(51000); await f.run(); await pending;
  assert.equal(incidents(f.calls)[0].events.some(e => e.event === "send"), false, "off-mode history survived");
});

test("seven quick taps enable section, shortcut, button and automatic saves; seven more disable them", async () => {
  const f = phone(); f.history.capability(5);
  f.taps(6); assert.equal(f.on(), false); assert.equal(f.nodes.diagnostictoast.textContent, "");
  f.tap(); assert.equal(f.on(), true); assert.equal(f.sectionShown(), true);
  assert.equal(f.nodes.diagnostictoast.textContent, "Developer mode on");
  assert.equal(f.key().prevented, true);
  assert.equal(f.nodes.diagnostictoast.textContent, "Recording the next 20 seconds before saving");
  f.at(21000); await f.run(); assert.equal(incidents(f.calls)[0].reason, "manual");
  assert.equal(f.nodes.diagnosticstatus.textContent, "Diagnostic history saved on the Mac.");
  f.nodes.savediagnostic.click(); f.at(42000); await f.run();
  assert.equal(incidents(f.calls)[1].reason, "manual");
  f.history.noScroll("m12"); f.at(63000); await f.run();
  assert.equal(incidents(f.calls)[2].reason, "no-scroll");
  f.runPage('settingsView.show("diagnostics")');
  f.taps(); assert.equal(f.on(), false); assert.equal(f.sectionShown(), false);
  assert.equal(f.nodes.diagnostictoast.textContent, "Developer mode off");
  assert.equal(f.runPage("settingsView.section()"), "editor");
  assert.equal(f.key().prevented, false);
  f.history.freeze(3000); f.at(90000); await f.run(); f.fire("pagehide");
  assert.equal(f.calls.length, 3); assert.equal(f.beacons.length, 0);
});

test("single taps and gaps of a second reset the count; the local switch survives reloads", () => {
  const store = new Map(), f = phone(store);
  f.taps(10, 1000); assert.equal(f.on(), false);
  f.taps(5); assert.equal(f.on(), false); f.tap(); assert.equal(f.on(), true);
  const reloaded = phone(store); assert.equal(reloaded.on(), true); assert.equal(reloaded.sectionShown(), true);
  reloaded.taps(); assert.equal(reloaded.on(), false);
  assert.equal(phone(store).on(), false);
});

test("turning off discards a held offline history and stops lifecycle beacons and later retry", async () => {
  const f = phone(); f.taps(); f.history.capability(5); f.navigator.onLine = false;
  f.nodes.savediagnostic.click(); f.at(22000); await f.run();
  assert.match(f.nodes.diagnosticstatus.textContent, /^Offline/);
  f.taps(); f.navigator.onLine = true; f.hidden(true); f.fire("pagehide");
  assert.equal(f.calls.length, 0); assert.equal(f.beacons.length, 0);
  f.hidden(false); f.taps(); f.nodes.savediagnostic.click();
  assert.equal(f.nodes.savediagnostic.textContent, "Save diagnostic history");
  f.at(45000); await f.run();
  assert.equal(incidents(f.calls).length, 1);
  assert.ok(incidents(f.calls)[0].marked > 1800000022000, "old retry was revived");
});

test("turning off cancels recovery collections without overwriting the mode toast or a new save", async () => {
  const f = phone(); f.taps(); f.history.capability(5);
  f.at(5000); f.history.noScroll("m12"); f.key();
  f.taps(); await f.run(); assert.equal(f.nodes.diagnostictoast.textContent, "Developer mode off");
  f.taps(); f.key(); await f.run(); assert.equal(f.nodes.savediagnostic.disabled, true);
  f.at(28000); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(incidents(f.calls)[0].reason, "manual");
});

test("ordinary page errors and notification lines remain enabled while histories are off", async () => {
  const f = phone();
  f.context.reportProblem("render", new Error("fixture error")); f.fire("pagehide");
  const batch = JSON.parse(await f.beacons[0].body.text());
  assert.equal(batch.reports[0].kind, "render"); assert.equal(incidents([batch]).length, 0);
  f.context.reportNotice({ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "yes" }); await f.run();
  assert.ok(f.calls.some(b => b.reports.some(r => r.kind === "notifycheck")));
});

test("disabling before a scheduled upload cancels it and resolves the caller", async () => {
  const f = phone(); f.taps(); // schema 1 schedules transport without recovery
  const pending = f.history.mark("settings");
  f.taps(); f.taps(); await f.run();
  assert.equal((await pending).status, "disabled");
  assert.equal(f.calls.length, 0);
  assert.equal(f.beacons.length, 0);
});

test("an active upload is aborted and queued saves cannot revive after re-enabling", async () => {
  const f = phone(); f.taps();
  let oldResolve, oldSignal;
  f.answer((url, init) => {
    oldSignal = init.signal;
    // Deliberately ignore abort: a late response must not revive old work.
    return new Promise(resolve => { oldResolve = resolve; });
  });
  const first = f.history.mark("settings"); await f.run();
  const queued = f.history.mark("shortcut");
  assert.equal(f.calls.length, 1);
  f.taps(); assert.equal(oldSignal.aborted, true);
  f.taps(); await f.run();
  assert.equal((await first).status, "disabled");
  assert.equal((await queued).status, "disabled");
  assert.equal(f.calls.length, 1);
  let newResolve;
  f.answer(() => new Promise(resolve => { newResolve = resolve; }));
  const fresh = f.history.mark("settings"); await f.run();
  oldResolve({ ok: false, status: 400 }); await f.run();
  const next = f.history.mark("shortcut"); await f.run();
  assert.equal(f.calls.length, 2, "old completion cleared the new upload's busy flag");
  f.answer("saved");
  newResolve({ ok: true, json: async () => ({ ok: true, written: 1, dropped: 0 }) });
  await f.run();
  assert.equal((await fresh).status, "saved");
  assert.equal((await next).status, "saved");
  assert.equal(f.calls.length, 3);
});

test("a late schema refusal cannot send a fallback history after off then on", async () => {
  const f = phone(); f.taps(); f.history.capability(5);
  let respond;
  f.answer(() => new Promise(resolve => { respond = resolve; }));
  const pending = f.history.mark("settings"); f.at(22000); await f.run();
  assert.equal(f.calls.length, 1);
  f.taps(); f.taps();
  respond({ ok: false, status: 400 }); await f.run();
  assert.equal((await pending).status, "disabled");
  assert.equal(f.calls.length, 1, "schema fallback uploaded discarded history");
  f.hidden(true); f.fire("pagehide"); assert.equal(f.beacons.length, 0);
});

test("disabled triggers record nothing and old trace tokens and frame callbacks stay discarded", async () => {
  const f = phone(); f.history.capability(5);
  const off = f.history.begin("request", { route: "/m/state" });
  assert.equal(off, null);
  f.history.observerSample(12); f.history.note("viewport", { vh: 800 });
  f.fireDocument("touchstart", { touches: [], target: {} }); assert.equal(f.frames(), 0);
  f.at(5000); f.tick(100);
  assert.equal((await f.history.mark("settings")).status, "disabled");
  f.taps();
  const old = f.history.begin("request", { route: "/m/state" });
  f.history.note("input", { action: "card", part: "touch", box: "m13" });
  f.fireDocument("touchstart", { touches: [], target: {} }); assert.equal(f.frames(), 1);
  f.taps(); f.taps();
  f.at(10000); f.frame(10000); f.history.end(old, { route: "/m/state", status: 500 });
  assert.equal(f.frames(), 0, "old frame watcher restarted");
  f.history.note("send", { box: "m12" });
  const pending = f.history.mark("settings"); f.at(30000); await f.run(); await pending;
  assert.equal(f.calls.length, 1); const report = incidents(f.calls)[0];
  assert.equal(report.reason, "manual");
  assert.equal(report.events.some(e => e.box === "m13" || ["request", "frame", "timer", "viewport"].includes(e.event) || e.part === "observer"), false);
  assert.ok(report.events.some(e => e.event === "send" && e.box === "m12"));
});

for (const name of ["board", "page"]) {
  test(`${name} reporter keeps errors, failed requests and notices with phone history disabled`, async () => {
    const f = fixture(name, { setup(context) { context.startReporter(name, { phoneHistory: false }); } });
    assert.equal(f.history, undefined);
    f.context.reportProblem("render", new Error("fixture render"));
    await assert.rejects(f.context.fetch("/broken"), /fixture request failure/);
    f.fire("pagehide");
    const batch = JSON.parse(await f.beacons[0].body.text());
    assert.equal(batch.page, name);
    assert.deepEqual(batch.reports.map(r => r.kind), ["render", "fetch"]);
    f.context.reportNotice({ kind: "notifytap", outcome: "opened" }); await f.run();
    assert.equal(f.calls[0].page, name);
    assert.equal(f.calls[0].reports[0].kind, "notifytap");
  });
}

test("disabling drops page-side create and gesture samples and stale frame notes", async () => {
  const f = phone(); f.history.capability(5);
  let reads = 0; const observers = [];
  const scroller = {
    get scrollTop() { reads++; return 400; }, clientHeight: 500, scrollHeight: 1500,
    isConnected: true, querySelector: () => ({}),
    closest: selector => selector === ".box.sel .replyview" || selector === ".box.sel" ? scroller : null,
  };
  Object.assign(f.context, { hist: null, MutationObserver: class {
    constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; }
  } });
  const down = () => f.fireDocument("touchstart", { touches: [{ clientX: 200, clientY: 600 }], target: scroller });
  down(); assert.equal(reads, 0, "off-mode gestures still measured diagnostic geometry");
  f.context.traceFrameOpportunity("drawer"); assert.equal(f.frames(), 0);
  f.taps(); down(); assert.ok(reads > 0); assert.equal(observers.length, 1);
  f.context.createDiagnostics.set("pending", { response: f.history.begin("create") });
  f.context.traceFrameOpportunity("drawer");
  f.taps(); assert.equal(f.context.createDiagnostics.size, 0); assert.equal(observers[0].disconnected, true);
  f.taps();
  observers[0].fn(); // Even a callback already delivered by an old observer is inert.
  f.at(5000); f.frame(5000);
  f.fireDocument("touchend", { type: "touchend" });
  const pending = f.history.mark("settings"); f.at(25000); await f.run(); await pending;
  const report = incidents(f.calls)[0];
  assert.equal(report.events.some(e => ["frame-one", "frame-two", "reply-swap", "touch", "touch-end"].includes(e.part)), false);
});
