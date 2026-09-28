// An invented board the size of the owner's, for the phone's reading: about
// 700 cards over five lanes, most of them done, each with a reply and the
// messages that reply was given, and a server started on it on a free port
// pair. Every word on a card is drawn one at a time from this repo's own docs,
// so the text reads like the board's and compresses no better than it: a
// drawn word never brings the phrase it stood in along with it.
//
// Nothing here reads the real board or its state file; the board lives in a
// temp folder that the caller removes.
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const LANES = [["facilitator", 0.6], ["pastureland", 0.15], ["tokens", 0.1], ["wiki", 0.08], ["hayloft", 0.07]];
const T0 = 1757000000;

function prng(seed){
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function words(){
  const text = ["RUNBOOK.md", "README.md", "CONTRIBUTING.md"]
    .map(name => readFileSync(path.join(ROOT, name), "utf8")).join("\n");
  return text.match(/[A-Za-z][A-Za-z'-]*/g);
}

// cards: how many; seed: which board. The default makes a full phone reading
// of about 800 KB, the size the phone's own logs show on Sep 27
function boardState({ cards = 705, seed = 912, dir } = {}){
  const rand = prng(seed);
  const pool = words();
  const pick = n => Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]);
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const sentence = () => {
    const w = pick(between(7, 22)).join(" ");
    return w[0].toUpperCase() + w.slice(1) + ".";
  };
  const prose = chars => {
    const parts = [];
    let size = 0;
    while (size < chars){
      const para = rand() < 0.25
        ? Array.from({ length: between(2, 4) }, () => "- " + sentence()).join("\n")
        : Array.from({ length: between(1, 4) }, sentence).join(" ");
      parts.push(para);
      size += para.length + 2;
    }
    return parts.join("\n\n");
  };
  const lane = () => {
    let r = rand();
    for (const [name, share] of LANES){ if ((r -= share) < 0) return name; }
    return LANES[0][0];
  };
  const boxes = [];
  for (let n = 1; n <= cards; n++){
    const done = rand() < 0.85;
    const replies = between(1, 9);
    const ts = T0 + n * 900;
    const length = rand() < 0.3 ? between(80, 300) : rand() < 0.75 ? between(300, 700) : between(700, 1600);
    const title = pick(between(3, 8)).join(" ");
    const full = prose(length);
    boxes.push({
      id: "m" + n, bucket: "meta", title: title[0].toUpperCase() + title.slice(1),
      reply: full, reply_full: full, reply_short: full,
      pending: [], done, parked: !done && rand() < 0.1, replies, full_replies: replies,
      reply_kind: "agent", reply_id: "r" + n.toString(16).padStart(6, "0"), reply_ts: ts + 300,
      answered: Array.from({ length: between(1, 2) }, (_, k) => ({ text: pick(between(4, 24)).join(" "), ts: ts + 60 * k })),
      state: "yours", hb: 0, ball: "you", ts, owner: lane(), agent_ts: ts + 300,
      seen: done ? replies : replies - 1, turn_ts: ts + 300, testing: false, creased: false,
    });
  }
  const projects = LANES.slice(1).map(([id]) => ({ id, name: id, dir: path.join(dir || "/tmp", id) }));
  return {
    title: "facilitator", boxes, inbox: [], busy: {}, claimed: {}, busy_ts: {}, ack: {},
    end: false, paused: false, next_mid: 1, next_bid: cards + 1, rev: 5000, ops: {},
    reply_variants_version: 1, history_counts_version: 1, projects,
    tabs: { order: LANES.map(([id]) => id), closed: [] },
  };
}

function patch(source, from, to){
  const out = source.replace(from, to);
  if (out === source) throw new Error(`fixture patch did not apply: ${from}`);
  return out;
}

// a server on the board above, from the server.py source given (this
// checkout's by default). Answers { origin, port, dir, stop }
async function startBoard(outer, { source, state, extraPatches = [] } = {}){
  const dir = path.join(outer, "app");
  mkdirSync(dir, { recursive: true });
  const port = await freePortPair();
  let text = source ?? readFileSync(path.join(ROOT, "server.py"), "utf8");
  text = patch(text, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  for (const [from, to] of extraPatches) text = patch(text, from, to);
  writeFileSync(path.join(dir, "server.py"), text);
  copyBridgeFiles(dir);
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state ?? boardState({ dir: outer })));
  const child = spawn("python3", [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]){
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;){
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    // a receipt query: it reads nothing of the board, so no reading is made
    try { if ((await fetch(origin + "/op?id=fixture-probe-01")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return {
    origin, port, dir,
    async stop(){
      if (child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
    },
  };
}

module.exports = { boardState, startBoard };
