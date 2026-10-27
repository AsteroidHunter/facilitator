// The board's live line in a real Chrome: the Mac board and the /page view on a
// throwaway board, heard through one SharedWorker that holds one line.
//
//   shared    two board windows (one on screen, one hidden) and a /page view:
//             one worker, one line held open at the board, and a new card
//             drawn in all three, the hidden one too
//   fallback  a board that refuses the line (its copy answers /events with
//             503 while a file says so): the page reads every 1.2 s as it
//             always did, and once the line is let through it is up within
//             the 30 s retry and the timed readings stop
//   files     the board serves board-line.js and its worker as scripts
//
// This file never starts a browser. It runs only against a Chrome that is
// already running with remote debugging, named by FACILITATOR_CDP_ENDPOINT
// (for example http://127.0.0.1:9222), and is skipped without one. Every page
// is a background tab made with Target.createTarget {background: true,
// newWindow: false}; none is brought forward or activated, no window or
// browser context is made, and only the tabs made here are closed, never the
// window's last one. A tab drawn as on screen is asked to be by focus
// emulation. Port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const ENDPOINT = (process.env.FACILITATOR_CDP_ENDPOINT || "").replace(/\/$/, "");
const skip = ENDPOINT ? false : "set FACILITATOR_CDP_ENDPOINT to a running Chrome's debugging address";
const settle = ms => new Promise(r => setTimeout(r, ms));

// the board's copy answers the line with 503 while app/events-off exists
const REFUSE = [
  "class EventsRoute:\n    async def __call__(self, scope, receive, send) -> None:\n",
  "class EventsRoute:\n    async def __call__(self, scope, receive, send) -> None:\n" +
  "        if (HERE / \"events-off\").exists():\n" +
  "            await _plain(503, {\"error\": \"the line is off for this test\"})(scope, receive, send)\n" +
  "            return\n",
];

class Browser {
  constructor(ws){
    this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = []; this.mine = new Set();
    ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)){
        const { resolve, reject } = this.wait.get(m.id);
        this.wait.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) for (const h of [...this.handlers]) h(m);
    });
  }
  static async connect(){
    const info = await (await fetch(ENDPOINT + "/json/version")).json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    return new Browser(ws);
  }
  send(method, params = {}, sessionId){
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.wait.set(id, { resolve, reject }));
  }
  async tab(url, { shown = true } = {}){
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", background: true, newWindow: false });
    this.mine.add(targetId);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const s = (m, p) => this.send(m, p, sessionId);
    const requests = [];
    this.handlers.push(m => {
      if (m.sessionId === sessionId && m.method === "Network.requestWillBeSent")
        requests.push({ url: m.params.request.url, at: Date.now() });
    });
    await s("Page.enable");
    await s("Runtime.enable");
    await s("Network.enable");
    if (shown) await s("Emulation.setFocusEmulationEnabled", { enabled: true });
    await s("Page.navigate", { url });
    const t = {
      targetId, requests,
      async eval(fn, arg){
        const r = await s("Runtime.evaluate", { expression: "(" + fn + ")(" + JSON.stringify(arg) + ")", awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async until(fn, what, ms = 15000, arg){
        const end = Date.now() + ms;
        for (;;){
          if (await t.eval(fn, arg).catch(() => false)) return Date.now();
          if (Date.now() > end) throw new Error("waited for " + what);
          await settle(50);
        }
      },
      reads: since => requests.filter(r => r.at >= since && /\/state(\?|$)/.test(new URL(r.url).pathname + new URL(r.url).search)).length,
    };
    return t;
  }
  // only a tab made here, and never the window's last tab
  async closeMine(){
    for (const targetId of [...this.mine]){
      const { targetInfos } = await this.send("Target.getTargets");
      if (!targetInfos.some(x => x.type === "page" && !this.mine.has(x.targetId))) break;
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
      this.mine.delete(targetId);
    }
  }
  close(){ this.ws.close(); }
}

// the sockets the board's process holds open: every answer closes its
// connection, so at rest these are the lines and nothing else
function openSockets(pid){
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED"], { encoding: "utf8" });
    return out.trim().split("\n").slice(1).length;
  } catch { return 0; }
}

// a board whose line can be refused: a board of its own, so its pages are of
// another origin and share no worker with the pages of the other tests
const refusing = () => startBoard({ prepare: ({ app }) => {
  const file = path.join(app, "server.py");
  const source = fs.readFileSync(file, "utf8");
  assert.ok(source.includes(REFUSE[0]), "the line's route moved; the refusal patch did not apply");
  fs.writeFileSync(file, source.replace(REFUSE[0], REFUSE[1]));
} });

let browser, board, refused;
before(async () => {
  if (skip) return;
  browser = await Browser.connect();
  board = await startBoard();
});
after(async () => {
  if (browser){ await browser.closeMine(); browser.close(); }
  if (board) await board.stop();
  if (refused) await refused.stop();
});

test("the board serves the line's two files as scripts", { skip }, async () => {
  for (const name of ["/board-line.js", "/board-line-worker.js"]){
    const r = await fetch(board.origin + name);
    assert.equal(r.status, 200, name);
    assert.match(r.headers.get("content-type"), /^application\/javascript/, name);
    assert.ok((await r.text()).includes("BoardLine"), name);
  }
});

test("two board windows and a /page view share one line, and a change is drawn in each", { skip }, async () => {
  const shown = await browser.tab(board.origin + "/");
  const hidden = await browser.tab(board.origin + "/", { shown: false });
  const view = await browser.tab(board.origin + "/page");
  const up = name => `() => typeof ${name} !== "undefined" && !!${name} && ${name}.up && !!lastState`;
  await shown.until(up("deskLine"), "the line on the board on screen");
  await hidden.until(up("deskLine"), "the line on the hidden board");
  await view.until(up("pageLine"), "the line on the /page view");
  assert.equal(await shown.eval(() => document.hidden), false);
  assert.equal(await hidden.eval(() => document.hidden), true);
  for (const [t, timer] of [[shown, "deskTicker"], [hidden, "deskTicker"], [view, "pageTicker"]])
    assert.equal(await t.eval(n => globalThis.eval(n), timer), 0, "a page with the line up still runs its timer");
  const { targetInfos } = await browser.send("Target.getTargets");
  const workers = targetInfos.filter(x => x.type === "shared_worker" && x.url.startsWith(board.origin));
  assert.equal(workers.length, 1, "the pages did not share one worker");
  assert.equal(workers[0].url, board.origin + "/board-line-worker.js");
  // the board holds one line open for all three pages
  let sockets = 0;
  for (let i = 0; i < 40 && (sockets = openSockets(board.child.pid)) !== 1; i++) await settle(250);
  assert.equal(sockets, 1, `the board holds ${sockets} connections open for three pages`);
  // at rest none of them reads the board, once each has read on its line's
  // opening (at most a second after it)
  await settle(2000);
  const quiet = Date.now();
  await settle(4000);
  for (const t of [shown, hidden, view]) assert.equal(t.reads(quiet), 0, "a page read a board that did not change");
  // a new card: each page draws it, the hidden one too
  const made = await (await fetch(board.origin + "/create?owner=facilitator", { method: "POST", body: "A card the line rings for" })).json();
  const asked = Date.now();
  const drawn = await Promise.all([
    shown.until(id => !!els[id], "the card on the board on screen", 5000, made.id),
    hidden.until(id => !!els[id], "the card on the hidden board", 5000, made.id),
    view.until(id => lastState.boxes.some(b => b.id === id), "the card on the /page view", 5000, made.id),
  ]);
  for (const at of drawn) assert.ok(at - asked < 3000, `a page drew the change ${at - asked} ms after it`);
  await fetch(board.origin + "/delete?box=" + encodeURIComponent(made.id), { method: "POST" });
  // the three go: each says bye, and the worker closes the line
  await browser.closeMine();
});

test("a page whose line is refused reads every 1.2 s as before, and stops once the line is let through", { skip }, async () => {
  refused = await refusing();
  const off = path.join(refused.app, "events-off");
  fs.writeFileSync(off, "");
  try {
    const t = await browser.tab(refused.origin + "/");
    await t.until(() => typeof deskLine !== "undefined" && !!deskLine && !!lastState, "the board");
    await settle(1500);
    assert.equal(await t.eval(() => deskLine.up), false, "the line was up though the board refused it");
    assert.ok(await t.eval(() => deskTicker !== 0), "the timed refresh does not run with the line refused");
    const from = Date.now();
    await settle(6000);
    const reads = t.reads(from);
    assert.ok(reads >= 4 && reads <= 6, `with the line refused the page read ${reads} times in 6 s`);
    fs.rmSync(off);
    // the browser gave up on a refused line; the page opens it again within 30 s
    await t.until(() => deskLine.up, "the line once let through", 40000);
    assert.equal(await t.eval(() => deskTicker), 0, "the timed refresh still runs with the line up");
    await settle(1500);
    const rest = Date.now();
    await settle(5000);
    assert.equal(t.reads(rest), 0, "the page still read on its timer with the line up");
  } finally {
    fs.rmSync(off, { force: true });
  }
});
