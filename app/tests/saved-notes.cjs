// Progress notes as a board saved them before POST /note was removed. The
// board refuses that route now, but the notes it took before then are still in
// state.json and transcript.jsonl and have to keep loading and showing as they
// always did, so a test writes them the way the old route did, straight into a
// stopped board's files:
//
//   the words go on the card over its last completed reply, the card's reply
//   count moves and its history count does not, the card enters the note state
//   with a fresh heartbeat, the turn stays with the agent, and the transcript
//   gets one note row per note.
//
// took: true is a note written over a claim holding every message queued on
// the card: those messages leave the queue and wait in the card's batch for the
// completed reply still to come, as the old route left them. A restart drops
// every claim, so nothing else about the claim needs writing down. hb, when
// given, is the heartbeat the card was saved with in place of a fresh one, for
// a note whose work went quiet while the board was down.
const fs = require("node:fs");
const path = require("node:path");

function saveNotes(data, id, texts, { took = false, hb = null } = {}) {
  const statePath = path.join(data, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const card = state.boxes.find(box => box.id === id);
  if (!card) throw new Error(`no card ${id} to save a note on`);
  const start = Date.now() / 1000;
  const rows = texts.map((text, i) => ({
    ts: start + i * 0.001, kind: "note", box: id, text,
    reply_full: text, reply_short: text, reply_variants_version: 1,
  }));
  for (const row of rows) {
    card.reply = card.reply_full = card.reply_short = row.text;
    card.replies = (card.replies || 0) + 1;
    card.reply_kind = "note";
    card.agent_ts = card.ts = card.hb = card.changed = row.ts;
    card.ball = "me";
    card.state = "note";
  }
  if (hb !== null) card.hb = hb;
  if (took) {
    const batch = Array.isArray(card.batch) ? card.batch : [];
    for (const m of card.pending) batch.push({ mid: m.mid, text: m.text, ts: m.ts, ...(m.via ? { via: m.via } : {}) });
    card.batch = batch;
    card.handed = [];
    card.pending = [];
  }
  state.inbox = (state.inbox || []).filter(bid => bid !== id || card.pending.length);
  if (card.pending.length && !state.inbox.includes(id)) state.inbox.push(id);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  fs.appendFileSync(path.join(data, "transcript.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

module.exports = { saveNotes };
