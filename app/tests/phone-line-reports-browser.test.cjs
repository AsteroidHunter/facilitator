// The live line's report in a real Chrome page at phone size: a board copy
// whose m.html sends its line report every 8 seconds rather than every 5
// minutes (so each on screen spans one of the board's 15 second lines), a phone page on it in developer mode, and the reports read back out
// of the copy's own dated client log, two on screen and one when the page is
// put away.
//
// This file never starts a browser. It runs only against a Chrome that is
// already running with remote debugging, named by FACILITATOR_CDP_ENDPOINT
// (for example http://127.0.0.1:9222), and is skipped without one. Its page is
// a background tab made with Target.createTarget {background: true,
// newWindow: false}, drawn as on screen by focus emulation; it is never brought
// forward, no window is made, and only the tab made here is closed, never the
// window's last one. Port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const ENDPOINT = (process.env.FACILITATOR_CDP_ENDPOINT || "").replace(/\/$/, "");
const skip = ENDPOINT ? false : "set FACILITATOR_CDP_ENDPOINT to a running Chrome's debugging address";
const settle = ms => new Promise(r => setTimeout(r, ms));
const PERIOD = ["LINE_REPORT_MS = 300000", "LINE_REPORT_MS = 8000"];

let ws, id = 0, made = null, board;
const waiting = new Map();
function send(method, params = {}, sessionId) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => waiting.set(n, { resolve, reject }));
}
before(async () => {
  if (skip) return;
  const info = await (await fetch(ENDPOINT + "/json/version")).json();
  ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  board = await startBoard({ prepare: ({ app }) => {
    const file = path.join(app, "m.html");
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.split(PERIOD[0]).length, 2, "the report's period moved; the shortening did not apply");
    fs.writeFileSync(file, source.replace(PERIOD[0], PERIOD[1]));
  } });
});
after(async () => {
  if (made) {
    // only the tab made here, and never the window's last tab
    const { targetInfos } = await send("Target.getTargets");
    if (targetInfos.some(t => t.type === "page" && t.targetId !== made))
      await send("Target.closeTarget", { targetId: made }).catch(() => {});
  }
  if (ws) ws.close();
  if (board) await board.stop();
});

// every line of the copy's dated client log, and its line reports
function clientLines() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(board.logs).filter(n => n.startsWith("client-")).sort(); } catch { return out; }
  for (const name of names)
    for (const line of fs.readFileSync(path.join(board.logs, name), "utf8").split("\n"))
      if (line.trim()) out.push(JSON.parse(line));
  return out;
}
const lineReports = () => clientLines().filter(r => r.kind === "linereport");
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error("waited for " + what);
    await settle(100);
  }
}

test("a phone page in developer mode writes its line reports into the board's client log", { skip }, async () => {
  const { targetId } = await send("Target.createTarget", { url: "about:blank", background: true, newWindow: false });
  made = targetId;
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await s("Emulation.setFocusEmulationEnabled", { enabled: true });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('phoneDeveloperMode', 'on');" });
  await s("Page.navigate", { url: board.origin + "/m" });
  await until(() => evaluate("typeof lastState !== 'undefined' && !!lastState && !document.hidden && " +
    "innerWidth === 390 && window.phoneHistory.version() === 7"), "the phone page on screen, reading the board");

  // two reports while on screen
  const shown = await until(async () => { const r = lineReports(); return r.length >= 2 && r; }, "two line reports in the client log", 40000);
  // then put away: Chrome hides a background tab that is no longer drawn as on screen
  await s("Emulation.setFocusEmulationEnabled", { enabled: false });
  await until(() => evaluate("document.hidden"), "the page put away");
  const all = await until(async () => { const r = lineReports(); return r.some(x => x.reason === "hidden") && r; },
    "the report sent when the page was put away");

  console.log("line reports in the fixture's client log:\n" + all.map(r => JSON.stringify(r)).join("\n"));
  const [first, second] = shown;
  for (const r of [first, second]) {
    assert.equal(r.reason, "period");
    assert.equal(r.v, 7);
    assert.equal(r.page, "phone");
    assert.ok(r.ms >= 7000 && r.ms <= 12000, `a report covered ${r.ms} ms`);
    assert.ok(r.lines >= 1, "a report on screen heard no line");
  }
  assert.deepEqual([first.n, second.n], [1, 2]);
  assert.equal(second.unsent, 0);
  // the first stretch opened the line, and in the hidden one it was lost for that reason
  assert.equal(first.stream[0].event, "stream-open");
  const hidden = all.find(x => x.reason === "hidden");
  assert.equal(hidden.stream.at(-1).event, "stream-lost");
  assert.equal(hidden.stream.at(-1).why, "hidden");
  // nothing on the page threw
  assert.deepEqual(clientLines().filter(r => r.kind === "error" || r.kind === "rejection"), []);
});
