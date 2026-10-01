// A local fixture for the card's snooze behaviour: a virtual clock, a small
// DOM, an invented board that answers the routes the real one answers, and the
// two page models (phone and desktop) written the way m.html and index.html
// draw a reading. Nothing here talks to a network or to the real board; every
// card, message and answer below is invented for the test.
//
// The clock is virtual so a 2.5 second request costs no real time and a 20
// second window can be waited out exactly. Requests are delivered at the far
// end of their delay, which is where the board applies them, so a message sent
// while a snooze is travelling really does land first.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SOURCE = new URL("../card-logic.js", import.meta.url);

const flushReal = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// ---- the clock ---------------------------------------------------------------
export function makeClock(start = 1_760_000_000_000){
  let ms = start, seq = 0;
  const timers = new Map();
  return {
    get ms(){ return ms; },
    get sec(){ return ms / 1000; },
    setTimeout(fn, delay = 0){ const id = ++seq; timers.set(id, { at: ms + Math.max(0, delay), fn }); return id; },
    clearTimeout(id){ timers.delete(id); },
    async advance(by){
      const end = ms + by;
      for (;;){
        let pick = null;
        for (const [id, t] of timers){
          if (t.at > end) continue;
          if (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id)) pick = { id, t };
        }
        if (!pick) break;
        ms = pick.t.at;
        timers.delete(pick.id);
        pick.t.fn();
        await flushReal();
      }
      ms = end;
      await flushReal();
    },
    async settle(){ await flushReal(); },
  };
}

// ---- the small DOM -----------------------------------------------------------
export function newEl(){
  const classes = new Set();
  let own = "";
  const el = {
    dataset: {}, children: [], parentNode: null,
    classList: {
      add(...c){ for (const x of c) classes.add(x); },
      remove(...c){ for (const x of c) classes.delete(x); },
      contains(c){ return classes.has(c); },
      toggle(c, on){
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    appendChild(n){ el.children.push(n); n.parentNode = el; return n; },
    setAttribute(){}, removeAttribute(){}, addEventListener(){},
    querySelector(){ return null; },
  };
  // the DOM's own rule about text, and the one a note node depends on: writing
  // text to a node throws away the children it was holding, and those children
  // are detached from it. A fixture that leaves that out cannot see a page
  // writing over a box that owns the element it meant to write to
  Object.defineProperty(el, "textContent", {
    get(){ return own + el.children.map(c => c.textContent).join(""); },
    set(v){
      for (const c of el.children) c.parentNode = null;
      el.children = [];
      own = v == null ? "" : String(v);
    },
  });
  Object.defineProperty(el, "className", {
    get: () => [...classes].join(" "),
    set(v){ classes.clear(); for (const c of String(v).split(" ")) if (c) classes.add(c); },
  });
  return el;
}

function makeDocument(){
  return {
    body: newEl(),
    createElement: () => newEl(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeStorage(){
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
  };
}

// ---- the invented board ------------------------------------------------------
// _shown's shape, enough of it for colour and place: the two flags first, then
// the queue, then whose turn it is
function shownState(b){
  if (b.done) return "done";
  if (b.parked) return "parked";
  if (b.pending.length) return "queued";
  if (!b.agentTs && !b.replies) return "new";
  return b.ball === "you" ? "yours" : "queued";
}

export function makeBoard(clock, cards){
  const boxes = (cards || [
    { id: "1", title: "first card", owner: "facilitator", ball: "you", replies: 1, agentTs: clock.sec - 300 },
    { id: "2", title: "second card", owner: "facilitator", ball: "you", replies: 1, agentTs: clock.sec - 600 },
  ]).map(c => ({
    bucket: "meta", done: false, parked: false, replies: 0, seen: 0, agentTs: 0, ts: clock.sec - 900,
    pending: [], ball: "you", ...c,
  })).map(c => ({ ...c, state: shownState(c) }));

  const board = {
    rev: 1,
    boxes,
    log: [],                       // every request as it was made
    delays: { "/park": 0, "/done": 0, "/m/state": 0, "/state": 0 },
    // one delay per request, in the order the requests are made, for the cases
    // where a later request has to arrive before an earlier one
    delayQueue: {},                // path -> [ms, ms, ...]
    refuse: null,                  // { path, status, times }: answered, never applied
    drop: null,                    // { path, times }: never reaches the board at all
    mute: null,                    // { path, times }: reaches the board; no answer comes back
    answers: [],                   // one-shot answers: { path, status, body, broken, apply }
    // the board's own ordering record: one fact per card AND stream together,
    // never one per card, so a second page touching a card cannot erase the
    // first page's own high water mark. The real board also forgets a pair on
    // age and holds a bounded number of them; that policy is covered by the
    // Python cases rather than modelled here
    parkOrder: {},                 // "card\u0000stream" -> { seq, at }
    carryNow: true,                // an older board that names no clock sets this false
    box(id){ return board.boxes.find(b => b.id === id); },
    // a message queued straight onto the board, the way a send that reached it
    // before a snooze did would be
    send(id, text){
      const b = board.box(id);
      b.pending.push({ text, ts: clock.sec });
      b.parked = false; b.ball = "me"; b.ts = clock.sec;
      b.state = shownState(b);
      board.rev++;
      return b;
    },
    remove(id){ board.boxes = board.boxes.filter(b => b.id !== id); board.rev++; },
    asked(path){ return board.log.filter(e => e.path === path); },
    // the handler contract on its own, with no transport in the way: what the
    // board answers a request built by hand. Used for the malformed cases,
    // which no page of ours can produce
    fetchSync(url, body){
      const [path, qs] = String(url).split("?");
      return route(path, Object.fromEntries(new URLSearchParams(qs || "")), body);
    },
  };

  const once = (rule, path) => {
    if (!rule || rule.path !== path) return null;
    if (rule.times != null){
      if (rule.times <= 0) return null;
      rule.times -= 1;
    }
    return rule;
  };
  const nextDelay = path => {
    const queued = board.delayQueue[path];
    if (Array.isArray(queued) && queued.length) return queued.shift();
    return board.delays[path] || 0;
  };
  const takeAnswer = path => {
    const at = board.answers.findIndex(a => a.path === path);
    return at < 0 ? null : board.answers.splice(at, 1)[0];
  };

  // the park handler as the patched server writes it: the page's own command
  // order first, then the later-message protection, then the value
  function park(params){
    const box = board.box(params.box);
    if (!box) return [400, { error: "bad box" }];
    const want = (params.v ?? "1") === "1";
    const sid = params.sid || "", seq = params.seq || "";
    if ((sid && !seq) || (!sid && seq)) return [400, { error: "bad park order" }];
    const kept = { parked: box.parked, done: box.done, rev: board.rev };
    if (sid){
      const place = Number(seq);
      if (!Number.isInteger(place) || place < 0) return [400, { error: "bad park order" }];
      const fact = box.id + "\u0000" + sid;   // this card and this stream, together
      const prior = board.parkOrder[fact];
      if (prior && place <= prior.seq)
        return [200, { ok: false, stale: "superseded", ...kept }];
      board.parkOrder[fact] = { seq: place, at: clock.ms };
    }
    const basis = Number(params.after || 0) || 0;
    if (want && basis){
      const newest = box.pending.reduce((n, m) => Math.max(n, m.ts || 0), 0);
      if (newest > basis) return [200, { ok: false, stale: "message", ...kept }];
    }
    box.parked = want;
    if (want) box.done = false;
    box.state = shownState(box);
    board.rev++;
    return [200, { ok: true, parked: box.parked, done: box.done, rev: board.rev }];
  }

  const phoneBox = b => ({
    id: b.id, bucket: b.bucket, title: b.title, replyFull: "", done: b.done, replies: b.replies,
    olderReplies: 0, ball: b.ball, parked: b.parked, ts: b.ts, owner: b.owner,
    pending: b.pending.length, pendingTexts: b.pending.map(m => m.text),
    pendingStamps: b.pending.map(m => m.ts), agentTs: b.agentTs, seen: b.seen,
    writing: false, bg: false, state: b.state,
  });

  function phoneState(params){
    const since = params.since === "" || params.since == null ? null : Number(params.since);
    const out = { rev: board.rev, changed: since === null || since !== board.rev, live: { agents: {} } };
    if (board.carryNow) out.now = clock.sec;
    if (out.changed) Object.assign(out, {
      title: "facilitator", tabs: { order: [], closed: [] }, pwds: { facilitator: "/lane/facilitator" },
      projects: [], paused: false, boxes: board.boxes.map(phoneBox),
    });
    return [200, out];
  }

  function uiState(){
    const out = {
      boxes: board.boxes.map(b => ({ ...phoneBox(b), reply: "", replyShort: "", context: "" })),
      rev: board.rev, pwds: { facilitator: "/lane/facilitator" }, projects: [], paused: false,
      tabs: { order: [], closed: [] }, title: "facilitator", agents: {},
    };
    if (board.carryNow) out.now = clock.sec;
    return [200, out];
  }

  function route(path, params, body){
    if (path === "/park" || path === "/done") return park(params);
    if (path === "/m/state") return phoneState(params);
    if (path === "/state") return uiState();
    if (path === "/send"){ board.send(params.box, String(body || "")); return [200, { ok: true }]; }
    return [404, { error: "no route" }];
  }

  // a reading answers from the board as it stood when the request was made,
  // since that is what a server builds and a slow link merely delays; a command
  // is applied at the far end of its delay, since that is where it arrives. A
  // message can therefore reach the board while a snooze is still travelling
  const reading = path => path === "/m/state" || path === "/state";

  // The one thing this fixture must be honest about: ARRIVAL AND THE CALLER'S
  // PROMISE ARE TWO DIFFERENT EVENTS. A deadline or a network failure ends the
  // caller's promise; it does not reach in and stop the board from receiving
  // the request. So delivery is always scheduled and always applied, and the
  // promise is a separate thing that may already be over by then. Only drop
  // means the request never reached the board at all.
  board.fetch = (url, init = {}) => {
    const [path, qs] = String(url).split("?");
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    const entry = { path, params, method: init.method || "GET", at: clock.ms,
                    delivered: null, answer: null, status: 0 };
    board.log.push(entry);
    const lost = once(board.drop, path);     // never arrives
    const muted = once(board.mute, path);    // arrives; the answer never comes back
    const deadline = init.signal && init.signal.deadlineAt;
    const snapshot = reading(path) ? route(path, params, init.body) : null;
    const wait = nextDelay(path);
    return new Promise((resolve, reject) => {
      let settled = false;
      if (!lost) clock.setTimeout(() => {
        entry.delivered = clock.ms;
        const refused = once(board.refuse, path);
        const override = takeAnswer(path);
        let status, answer;
        if (refused){
          status = refused.status; answer = { error: "refused" };
        } else if (override && override.apply === false){
          status = override.status || 200; answer = override.body;   // the board did not act
        } else {
          const [ran, gave] = snapshot || route(path, params, init.body);
          status = override ? (override.status || 200) : ran;
          answer = override ? override.body : gave;
        }
        entry.answer = answer; entry.status = status;
        if (muted || settled) return;   // nobody is listening for this one
        settled = true;
        resolve({
          ok: status >= 200 && status < 300, status,
          json: async () => {
            if (override && override.broken) throw new SyntaxError("unexpected end of JSON input");
            return answer;
          },
        });
      }, wait);
      if (deadline != null) clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error("the operation was aborted due to timeout");
        err.name = "TimeoutError";
        reject(err);   // the request itself carries on, exactly as it does in a browser
      }, Math.max(0, deadline - clock.ms));
    });
  };

  return board;
}

// ---- the shared helper, loaded the way a page loads it ------------------------
export function loadLogic({ clock, board }){
  const sandbox = {
    console,
    document: makeDocument(),
    localStorage: makeStorage(),
    fetch: board.fetch,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: id => clock.clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    Date: class extends Date { static now(){ return clock.ms; } },
    AbortSignal: { timeout: ms => ({ deadlineAt: clock.ms + ms }) },
    CardMarkdown: { render: t => String(t || "") },
    // what a page declares for itself
    els: {}, lastState: null, selectedId: null, activeOwner: "facilitator", lastSel: {},
    poll(){}, select(){}, growPend(){}, apply(){}, reportProblem: null,
  };
  const ctx = createContext(sandbox);
  runInContext(readFileSync(SOURCE, "utf8"), ctx, { filename: "card-logic.js" });
  return ctx;
}

export function heldTaps(ctx){ return runInContext("Object.keys(flagHolds)", ctx); }

// ---- the phone page ----------------------------------------------------------
// m.html's own pass over a reading, with the two lines this change touches:
// holdFlags before anything is drawn, and the note the poll may not clear
export function makePhone(ctx, board, clock){
  const page = { list: [], view: "todo", problems: [], lastRev: null, reads: 0, fails: 0 };

  const makeBox = id => (ctx.els[id] = { box: newEl(), meta: newEl(), reply: newEl(), titleEl: newEl() });

  function apply(state){
    for (const id of Object.keys(ctx.els))
      if (!state.boxes.some(b => b.id === id)) delete ctx.els[id];
    for (const b of state.boxes){
      const el = ctx.els[b.id] || makeBox(b.id);
      const cs = ctx.cardState(b);
      el.box.classList.toggle("done", cs === "done");
      el.box.classList.toggle("parked", cs === "parked");
      if (el.meta.textContent && el.meta.textContent.indexOf("send ") !== 0 &&
          el.meta.dataset.flagnote !== "1") el.meta.textContent = "";
    }
    if (ctx.selectedId && !state.boxes.some(b => b.id === ctx.selectedId)) ctx.selectedId = null;
    page.list = ctx.viewPool(state).map(b => b.id);
  }

  let run = null, again = false;
  function poll(){
    if (run){ again = true; return run.then(() => run || null); }
    run = read().finally(() => { run = null; if (again){ again = false; poll(); } });
    return run;
  }
  async function read(){
    const asked = clock.ms;
    page.reads++;
    let data = null;
    try {
      const r = await board.fetch("/m/state?since=" + (page.lastRev == null ? "" : page.lastRev),
        { cache: "no-store", signal: { deadlineAt: clock.ms + 8000 } });   // m.html's own reading deadline
      if (!r.ok) throw new Error("status " + r.status);
      data = await r.json();
    } catch (e){ page.fails++; }
    if (!data) return;
    if (data.changed){
      const state = { ...data, ...(data.live || {}), fetchedAt: asked };
      delete state.live;
      ctx.holdFlags(state);
      ctx.lastState = state;
      page.lastRev = data.rev;
      apply(state);
    } else if (ctx.lastState){
      Object.assign(ctx.lastState, data.live || {});
      ctx.lastState.fetchedAt = asked;
      if (typeof data.now === "number") ctx.lastState.now = data.now;
      page.list = ctx.viewPool(ctx.lastState).map(b => b.id);
    }
  }

  ctx.apply = apply;
  ctx.poll = poll;
  ctx.select = id => { ctx.selectedId = id; };
  ctx.reportProblem = (what, err) => page.problems.push(what + ": " + (err && err.message));

  page.poll = poll;
  // a reading asked for and given time to arrive: the clock has to be turned
  // for the answer to come, so waiting on the reading alone would wait for ever
  page.pollNow = async (ms = 5) => { const p = poll(); await clock.advance(ms); return p; };
  page.tap = id => ctx.toggleFlag(id, "park");
  page.card = id => ctx.els[id];
  page.classes = id => (ctx.els[id] ? ctx.els[id].box.className.split(" ").filter(Boolean) : null);
  page.parked = id => !!ctx.els[id] && ctx.els[id].box.classList.contains("parked");
  page.waiting = id => !!ctx.els[id] && ctx.els[id].box.classList.contains("flagwait");
  page.note = id => (ctx.els[id] ? ctx.els[id].meta.textContent : "");
  page.setView = v => { ctx.setTicketViewOf("facilitator", v); page.view = v; if (ctx.lastState) apply(ctx.lastState); };
  page.select = id => { ctx.selectedId = id; };
  page.selected = () => ctx.selectedId;
  return page;
}

// ---- the desktop page --------------------------------------------------------
// index.html's pass, including the small card in the corner, which shares the
// one els entry with the large card and reaches the same shared helper
export function makeDesktop(ctx, board, clock){
  const page = { sections: {}, problems: [], reads: 0, fails: 0 };

  // the desktop card's own shape, which is not the phone's: the note element
  // (metaNote) is a child of a box the page also keeps a name for (meta). Both
  // names are on the card's entry, so anything writing text to the wrong one
  // destroys the other, and this fixture is only honest about that if it holds
  // the two nodes the way the page does
  const makeCard = () => {
    const box = newEl(), meta = newEl(), metaNote = newEl(), toc = newEl();
    meta.appendChild(metaNote);
    box.appendChild(meta);
    return { box, meta, metaNote, toc };
  };

  const build = state => {
    for (const b of state.boxes)
      if (!ctx.els[b.id]) ctx.els[b.id] = makeCard();
  };

  function apply(state){
    for (const id of Object.keys(ctx.els))
      if (!state.boxes.some(b => b.id === id)) delete ctx.els[id];
    for (const b of state.boxes){
      const el = ctx.els[b.id] || (ctx.els[b.id] = makeCard());
      const cs = ctx.cardState(b);
      el.box.classList.toggle("done", cs === "done");
      el.box.classList.toggle("parked", cs === "parked");
      // the section the card is filed under, and the toc entry beside it
      page.sections[b.id] = cs === "done" ? "done" : cs === "parked" ? "later" : "now";
      el.toc.className = cs === "parked" ? "t-later" : cs === "done" ? "t-done" : "";
      if (el.metaNote.textContent && el.metaNote.dataset.flagnote !== "1") el.metaNote.textContent = "";
    }
    page.order = ctx.poolOf(state).map(b => b.id);
    page.list = ctx.viewPool(state).map(b => b.id);
  }

  async function poll(){
    page.reads++;
    let state;
    const asked = clock.ms;
    try {
      state = await (await board.fetch("/state")).json();
      state.fetchedAt = asked;
    } catch (e){ page.fails++; return; }
    ctx.holdFlags(state);
    if (!ctx.lastState) build(state);
    apply(state);
    ctx.lastState = state;
  }

  ctx.apply = apply;
  ctx.poll = poll;
  ctx.select = id => { ctx.selectedId = id; };
  ctx.reportProblem = (what, err) => page.problems.push(what + ": " + (err && err.message));

  page.poll = poll;
  page.pollNow = async (ms = 5) => { const p = poll(); await clock.advance(ms); return p; };
  page.tap = id => ctx.toggleFlag(id, "park");        // the large card's chip
  page.tapMini = id => ctx.toggleFlag(id, "park");    // the corner card's chip, same helper
  page.card = id => ctx.els[id];
  page.parked = id => !!ctx.els[id] && ctx.els[id].box.classList.contains("parked");
  page.waiting = id => !!ctx.els[id] && ctx.els[id].box.classList.contains("flagwait");
  page.note = id => (ctx.els[id] ? ctx.els[id].metaNote.textContent : "");
  page.section = id => page.sections[id];
  page.toc = id => (ctx.els[id] ? ctx.els[id].toc.className : null);
  return page;
}

// ---- one page, ready to tap --------------------------------------------------
export async function openPage(kind = "phone", cards){
  const clock = makeClock();
  const board = makeBoard(clock, cards);
  const ctx = loadLogic({ clock, board });
  const page = kind === "phone" ? makePhone(ctx, board, clock) : makeDesktop(ctx, board, clock);
  const first = page.poll();
  await clock.advance(1);
  await first;
  return { clock, board, ctx, page };
}
