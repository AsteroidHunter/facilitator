// The onboarding, end to end on a whole board copied into a throwaway folder,
// with a throwaway home and no browser: a board with no profile tells its page
// to put the onboarding up, serves the onboarding for its own origin to frame,
// makes the sample project in the home folder, takes the profile the closing
// card saves, and from then on opens as a board. With an email given, the
// email and the answers reach PostHog's capture API once, which here is a
// listener on this machine: the copied usage_counts.py and the board's
// FACILITATOR_POSTHOG_ENDPOINT are pointed at it, so nothing can reach the
// real PostHog. The save answers before PostHog does, however slow it is or
// when it refuses, and the identify goes afterwards. The page files are read
// for what the onboarding and the Profile section say. Nothing here touches
// port 8877.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { startBoard, ROOT } = require("./board-fixture.cjs");
const { noProfile } = require("./fixture-auth.cjs");

const ONBOARDING = fs.readFileSync(path.join(ROOT, "onboarding.html"), "utf8");
const MAC = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const PHONE = fs.readFileSync(path.join(ROOT, "m.html"), "utf8");

// PostHog's capture API, as far as the board's sender needs it: every body kept.
// held: each answer waits until release(), as a slow PostHog's would
async function fakePostHog({ held = false } = {}) {
  const bodies = [], waiting = [];
  let answered = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      bodies.push({ path: req.url, body: JSON.parse(raw) });
      const answer = () => { answered++; res.end("{\"status\": 1}"); };
      if (held) waiting.push(answer);
      else answer();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { bodies, url: `http://127.0.0.1:${server.address().port}/i/v0/e/`, get answered() { return answered; },
           release: () => { held = false; waiting.splice(0).forEach(answer => answer()); },
           close: () => { held = false; waiting.splice(0).forEach(answer => answer()); return new Promise(r => server.close(r)); } };
}

// a port on this machine that nothing listens on: connections to it are refused
async function refusingPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < end, "timed out waiting for " + what);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const installOf = board => JSON.parse(fs.readFileSync(path.join(board.data, "usage-install.json"), "utf8"));

// the sender copied beside the board with its endpoint on the fake
function senderAt(app, url) {
  const source = fs.readFileSync(path.join(ROOT, "usage_counts.py"), "utf8");
  const real = 'ENDPOINT = "https://us.i.posthog.com/i/v0/e/"';
  assert.ok(source.includes(real), "the sender's endpoint line moved");
  fs.writeFileSync(path.join(app, "usage_counts.py"), source.replace(real, `ENDPOINT = ${JSON.stringify(url)}`));
  fs.copyFileSync(path.join(ROOT, "agent_names.py"), path.join(app, "agent_names.py"));
}

const json = response => JSON.parse(response.text);

// the board's page asking for the onboarding as its frame's document: a
// navigation, which carries no Origin
function frameOpen(board) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: board.port, method: "GET", path: "/onboarding",
      headers: { Host: `127.0.0.1:${board.port}`, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate",
                 "Sec-Fetch-Dest": "iframe" } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a board with no profile puts the onboarding up, and the profile it saves opens the board", async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-onboarding-home-")));
  const posthog = await fakePostHog();
  const board = await startBoard({
    seed: { title: "facilitator", items: [] },
    extra: ["onboarding.html", "magic-box.js"],
    env: { HOME: home, FACILITATOR_POSTHOG_ENDPOINT: posthog.url },
    prepare: ({ app }) => { noProfile(app); senderAt(app, posthog.url); },
  });
  t.after(async () => { await board.stop(); await posthog.close(); fs.rmSync(home, { recursive: true, force: true }); });

  const lead = (await board.call("GET", "/board-settings.js")).text.split("/*")[0];
  assert.match(lead, /globalThis\.BOARD_ONBOARDING=true;$/);
  assert.equal(json(await board.call("GET", "/profile")).complete, false);
  // every reading says so as well, before and after a restart, so a page left
  // open across the restart puts the onboarding up without a reload
  assert.equal(json(await board.call("GET", "/state")).onboarding, true);
  await board.restart();
  assert.equal(json(await board.call("GET", "/state")).onboarding, true, "a restarted board stopped asking");

  const page = await frameOpen(board);
  assert.equal(page.status, 200);
  assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(page.headers["content-security-policy"], "frame-ancestors 'self'");
  const version = /id="npversion">(v[0-9.]+)</.exec(MAC)[1];
  assert.ok(page.text.includes(`<meta name="facilitator-version" content="${version}">`));
  assert.equal((await board.call("GET", "/")).headers["x-frame-options"], "DENY", "the board itself became frameable");
  // the picture on 101: Phone App is the file in assets/, served as WebP, and like the page never through the phone's port
  const picture = await fetch(board.origin + "/assets/phone_app_on_stand.webp");
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get("content-type"), "image/webp");
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), fs.readFileSync(path.join(ROOT, "assets", "phone_app_on_stand.webp")));
  assert.equal((await fetch(`http://127.0.0.1:${board.port + 1}/assets/phone_app_on_stand.webp`)).status, 404);
  // and the board serves the magic box's placing, which the page loads for the box the picture stands in
  const placing = await board.call("GET", "/magic-box.js");
  assert.equal(placing.status, 200);
  assert.ok(placing.text.includes("root.MagicBox = {"));

  // the run's first move: the sample project, then its tab as "Open a new folder" makes one
  const made = json(await board.call("POST", "/onboarding/sample", ""));
  assert.deepEqual(made, { ok: true, path: path.join(home, "facilitator-sample"), made: true });
  assert.deepEqual(fs.readdirSync(made.path).sort(), ["facilitator-sample-internal", "facilitator-sample-wiki"]);
  assert.deepEqual(fs.readdirSync(path.join(made.path, "facilitator-sample-internal")), ["example-note.md"]);
  assert.deepEqual(fs.readdirSync(path.join(made.path, "facilitator-sample-wiki")), ["example-page.md"]);
  const project = json(await board.call("POST", "/project?name=facilitator-sample", made.path));
  assert.equal(project.id, "facilitator-sample");
  const again = json(await board.call("POST", "/onboarding/sample", ""));
  assert.equal(again.made, false);
  const pwds = json(await board.call("GET", "/state")).pwds;
  assert.equal(pwds["facilitator-sample"], again.path, "a second run would not find the tab by its folder");

  // the closing card's save, an email given being the yes
  const answers = { name: "Ada Lovelace", email: "ada@example.org", emailYes: true,
                    work: "A research tool for my lab", timeZone: "America/Phoenix" };
  const saved = await board.call("POST", "/profile", JSON.stringify(answers));
  assert.equal(saved.status, 200, saved.text);
  assert.equal("sent" in json(saved), false, "the save still says what PostHog did, so it waited on it");
  // PostHog is told afterwards, on a thread of its own
  await until(() => installOf(board).identify_done, "the identify");
  assert.equal(posthog.bodies.length, 1);
  const [identify] = posthog.bodies;
  assert.equal(identify.path, "/i/v0/e/");
  assert.equal(identify.body.event, "$identify");
  assert.deepEqual(identify.body.properties, { $geoip_disable: true, $set: {
    email: "ada@example.org", name: "Ada Lovelace", work: "A research tool for my lab",
    time_zone: "America/Phoenix" } });
  const install = installOf(board);
  assert.equal(identify.body.distinct_id, install.install_id);
  const kept = JSON.parse(fs.readFileSync(path.join(board.data, "profile.json"), "utf8"));
  assert.deepEqual(kept, { name: "Ada Lovelace", email: "ada@example.org", email_yes: true,
                           work: "A research tool for my lab", time_zone: "America/Phoenix",
                           picture: null });   // drawn by the first page that needs it, never sent
  assert.equal(fs.statSync(path.join(board.data, "profile.json")).mode & 0o777, 0o600);

  // an edit in Settings while the yes holds goes once, alone; the yes taken back sends nothing more.
  // a page from before that still sends an agent is taken, and the agent is dropped
  const edited = await board.call("POST", "/profile", JSON.stringify({ work: "Teaching", agent: "Codex", timeZone: "America/Phoenix" }));
  assert.equal(edited.status, 200, edited.text);
  assert.equal("agent" in json(edited), false, "the answer still holds an agent");
  await until(() => installOf(board).identify_done, "the edit's identify");
  assert.equal(posthog.bodies.length, 2);
  assert.deepEqual(posthog.bodies[1].body.properties, { $geoip_disable: true, $set: { work: "Teaching" } });
  assert.equal("agent" in JSON.parse(fs.readFileSync(path.join(board.data, "profile.json"), "utf8")), false);
  await board.call("POST", "/profile", JSON.stringify({ emailYes: false }));
  await board.call("POST", "/profile", JSON.stringify({ work: "Writing" }));
  assert.equal(posthog.bodies.length, 2);

  assert.doesNotMatch((await board.call("GET", "/board-settings.js")).text, /BOARD_ONBOARDING/);
  assert.equal("onboarding" in json(await board.call("GET", "/state")), false, "a saved profile is still asked for");
  await board.restart();
  assert.doesNotMatch((await board.call("GET", "/board-settings.js")).text, /BOARD_ONBOARDING/);
  assert.equal("onboarding" in json(await board.call("GET", "/state")), false);
  assert.equal(json(await board.call("GET", "/profile")).name, "Ada Lovelace");
  const log = fs.readdirSync(board.logs).map(f => fs.readFileSync(path.join(board.logs, f), "utf8")).join("");
  for (const value of ["Ada", "ada@example.org", "research", "Teaching", "Writing", install.install_id])
    assert.ok(!log.includes(value), "the log holds " + value);
});

// the board takes the onboarding away two seconds after its readings stop asking
// for it unless the frame's save has answered (onboardingWatch in index.html), so
// the save must never wait on PostHog
test("the profile save answers before PostHog does, slow or refusing, and the identify still goes once", async t => {
  const answers = JSON.stringify({ name: "Ada Lovelace", email: "ada@example.org", emailYes: true,
                                   work: "A research tool for my lab", timeZone: "America/Phoenix" });
  const boardAt = url => startBoard({ extra: ["onboarding.html"], env: { FACILITATOR_POSTHOG_ENDPOINT: url },
                                      prepare: ({ app }) => { noProfile(app); senderAt(app, url); } });
  const timed = async board => {
    const start = Date.now();
    const saved = await board.call("POST", "/profile", answers);
    return { saved, ms: Date.now() - start };
  };

  // a PostHog that holds its answer: the summary card's save and the last card's same save both answer first
  const slow = await fakePostHog({ held: true });
  const board = await boardAt(slow.url);
  t.after(async () => { await board.stop(); await slow.close(); });
  for (const which of ["the summary card's save", "the last card's save"]) {
    const { saved, ms } = await timed(board);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(slow.answered, 0, which + " waited for PostHog");
    assert.ok(ms < 2000, which + " took " + ms + " ms, past the two seconds the board waits before it takes the onboarding away");
  }
  assert.equal("onboarding" in json(await board.call("GET", "/state")), false);
  await until(() => slow.bodies.length === 1, "the identify to reach PostHog");
  slow.release();
  await until(() => installOf(board).identify_done, "PostHog's answer to the identify");
  assert.equal(slow.bodies.length, 1, "the last card's save told PostHog again");
  assert.deepEqual(slow.bodies[0].body.properties, { $geoip_disable: true, $set: {
    email: "ada@example.org", name: "Ada Lovelace", work: "A research tool for my lab", time_zone: "America/Phoenix" } });

  // a PostHog that refuses: the save answers at once and the identify is kept for a later look
  const url = `http://127.0.0.1:${await refusingPort()}/i/v0/e/`;
  const offline = await boardAt(url);
  t.after(() => offline.stop());
  const { saved, ms } = await timed(offline);
  assert.equal(saved.status, 200, saved.text);
  assert.ok(ms < 2000, "the save took " + ms + " ms");
  const logged = () => fs.readdirSync(offline.logs).map(f => fs.readFileSync(path.join(offline.logs, f), "utf8")).join("");
  await until(() => /"what": "identify", "outcome": "failed"/.test(logged()), "the identify to fail");
  const kept = installOf(offline);
  assert.deepEqual([kept.feedback_yes, kept.email, kept.identify_done], [true, "ada@example.org", false]);
});

test("a board that already has a profile opens as a board", async t => {
  const board = await startBoard({ extra: ["onboarding.html"] });
  t.after(() => board.stop());
  assert.doesNotMatch((await board.call("GET", "/board-settings.js")).text, /BOARD_ONBOARDING/);
  assert.equal(json(await board.call("GET", "/profile")).complete, true);
});

// the onboarding's questions and its send, run in a vm with the page around
// the send stubbed: what a send does is recorded. No browser.
const grab = (from, to) => {
  const start = ONBOARDING.indexOf(from), end = ONBOARDING.indexOf(to, start);
  assert.ok(start >= 0 && end > start, "the onboarding's source moved: " + from);
  return ONBOARDING.slice(start, end);
};
// a value made in a vm, as this realm's own, so a deep compare sees its contents
const out = value => JSON.parse(JSON.stringify(value));
const QUESTION_SOURCE = () => [
  grab("  function said(text){", "  function plain(text)"),
  grab("  const ADDRESS = ", "  // the last card closed"),
  grab("  const numbered = ", "  // the board's marks a card's words"),
].join("\n");

test("the email is checked: an empty Enter and a malformed email keep the question and ask for one", () => {
  const context = vm.createContext({});
  vm.runInContext(QUESTION_SOURCE(), context);
  const problem = text => vm.runInContext("emailProblem", context)(text);
  const empty = problem(""), bad = problem("ada");
  assert.ok(empty && bad && empty !== bad, "an empty box and a malformed email are not both asked for");
  for (const line of [empty, bad]) {
    assert.ok(line.length <= 70, "not one short line: " + line);
    assert.doesNotMatch(line, /\n|PostHog|skip/i);
  }
  for (const text of ["ada", "ada@", "ada@example", "@example.org", "ada@.org", "ada example@x.org", "a@b@c.org", "x".repeat(250) + "@a.co"])
    assert.equal(problem(text), bad, "taken as an email: " + text);
  for (const text of ["ada@example.org", "a.b+c@sub.example.co.uk", "  ada@example.org.  "])
    assert.equal(problem(text), "", "refused as an email: " + text);
});

// the page's own sendFrom(), on the page of one question, with the box holding text
function sendOn(field, text) {
  const calls = [];
  const note = name => (...args) => { calls.push([name, ...args]); };
  const card = { pages: [{ field }], pending: [], asking: null, askingAt: null,
                 el: { ta: { value: text }, tick() {}, metaNote: {} } };
  const context = vm.createContext({
    calls, card, hist: null, render: (el, raw) => calls.push(["render", raw]), printReply: note("printReply"),
    pageRaw: (c, i) => i + ":" + c.asking, showKeys: note("showKeys"), KEYS_IN_MS: 0, armSentMotion: () => null,
    sentLaunch: (el, sent) => { calls.push(["sent", sent]); return {}; }, caretQueue() {},
    answerOnLanding: note("answerOnLanding"),
  });
  vm.runInContext([QUESTION_SOURCE(),
    grab("  function pageOnShow(card){", "  // the answer comes the moment the send's flight")].join("\n"), context);
  const sent = vm.runInContext("sendFrom(card)", context);
  return { sent, calls, card, QUESTIONS: vm.runInContext("QUESTIONS", context) };
}

test("every question is needed: an empty Enter keeps each question and asks for its answer in one short line", () => {
  const { QUESTIONS } = sendOn("name", "");
  assert.deepEqual(out(QUESTIONS.map(q => q.field)), ["name", "email", "work"]);
  const lines = new Set();
  for (const q of QUESTIONS) {
    for (const text of ["", "   ", "\n"]) {
      const { sent, calls, card } = sendOn(q.field, text);
      assert.equal(sent, false, "an empty " + q.field + " was taken");
      assert.ok(!calls.some(c => c[0] === "sent" || c[0] === "answerOnLanding"), "an empty " + q.field + " was sent");
      assert.equal(card.asking, q.empty, "the " + q.field + " question did not ask for its answer");
      assert.equal(card.askingAt, 0);
      assert.deepEqual(calls.find(c => c[0] === "render"), ["render", "0:" + q.empty]);
      assert.ok(calls.some(c => c[0] === "printReply"), "the line is not shown");
    }
    assert.ok(q.empty.length <= 70 && /^Please /.test(q.empty) && !/\n|skip/i.test(q.empty), "not one short line: " + q.empty);
    lines.add(q.empty);
  }
  assert.equal(lines.size, 3, "two questions ask for their answer with the same line");
  // an answer goes through, and only the email is checked beyond being there
  for (const [field, text] of [["name", "Ada"], ["email", "ada@example.org"], ["work", "Research"]]) {
    const { sent, calls, card } = sendOn(field, text);
    assert.equal(sent, true, field);
    assert.deepEqual(calls.find(c => c[0] === "sent"), ["sent", text]);
    assert.equal(card.asking, null);
  }
  const bad = sendOn("email", "ada");
  assert.equal(bad.sent, false, "a malformed email was taken");
  assert.match(bad.card.asking, /does not look like an email/);
  // no line says Enter with nothing typed skips, and an empty answer is never kept
  assert.doesNotMatch(ONBOARDING, /SKIP_HINT|to skip|Skipped\.|Cleared your|needed: true/);
  assert.ok(ONBOARDING.includes("parts.push(q.ask, q.note, card.askingAt === i && card.asking);"));
  assert.ok(ONBOARDING.includes("card.asking = card.askingAt = null;"), "an answer leaves the ask on the page");
});

test("no question asks for a choice, and a question that did would take a number or a name", () => {
  const context = vm.createContext({});
  vm.runInContext([QUESTION_SOURCE(), grab("  function readAnswer(q, text){", "  // ---- sending, and the answer"),
                   "this.readAnswer = readAnswer; this.QUESTIONS = QUESTIONS;"].join("\n"), context);
  const { QUESTIONS, readAnswer } = context;
  for (const q of QUESTIONS) assert.ok(!q.choices && !q.note, q.field + " still asks for a choice");
  const q = { choices: ["Red", "Green", "Both"] };
  for (const [text, picked] of [["1", "Red"], ["3", "Both"], ["#3", "Both"], [" 3. ", "Both"], ["both", "Both"], ["BOTH.", "Both"], ["green", "Green"]])
    assert.equal(readAnswer(q, text), picked, "read " + JSON.stringify(text));
  // a number past the list, or other words, are kept as typed
  for (const text of ["4", "0", "Neither", "both of them"]) assert.equal(readAnswer(q, text), text, "changed " + text);
  // the answers to the questions asked are kept as typed
  for (const text of ["2", "Claude Code", "Ada"]) assert.equal(readAnswer(QUESTIONS[0], text), text, "changed " + text);
});

test("the last page lists the name, the email and the work under what you told us, and no main agent", () => {
  const context = vm.createContext({ HINT: "reply" });
  vm.runInContext([
    grab("  function plain(text){", "  // the answer a message gives"),
    grab("  const key = name =>", "  // the timings."),
    "const profile = { name: 'Ada', email: 'ada@example.org', work: 'Research', timeZone: null };",
    grab("  function pageRaw(card, i){", "  // every card's words were written"),
    "this.pageRaw = pageRaw;",
  ].join("\n"), context);
  const card = { asking: null, askingAt: null,
                 pages: ["name", "email", "work", null].map((field, i) => ({ field, head: i ? "Got it." : null })) };
  const last = context.pageRaw(card, 3);
  assert.match(last, /Here is what you told us:\n\n- Name: Ada\n- Email: ada@example\\.org\n- Work: Research$/m);
  assert.doesNotMatch(last, /agent/i);
  assert.match(last, /To change any of the previous answers/);
});

// the page's own finish() (the done chord and the cross of the last card both call it) and keepProfile()
// (the earlier save, when the summary card is passed), run in a vm with the page around them stubbed: the
// card moves and the saves are recorded. No browser.
async function finishWith(answers, { run = "finish()", ok = true } = {}) {
  const calls = [];
  const note = name => (...args) => { calls.push([name, ...args]); };
  const onboard = { asking: null, askingAt: null, el: { onboard: true }, pages: [{}, {}] };
  const context = vm.createContext({
    calls, onboard, cards: [{}, onboard], profile: { timeZone: null, ...answers },
    show: note("show"), leaveHistory: note("leaveHistory"), nudge: note("nudge"), printReply: note("printReply"),
    render: (el, raw) => calls.push(["render", raw]), pageRaw: (card, i) => i + ":" + card.asking,
    unlight: note("unlight"), caretQueue: note("caretQueue"), projectReady: Promise.resolve(null),
    fetch: async (url, init) => { calls.push(["fetch", url, JSON.parse(init.body)]); return { ok }; },
    feedback: { setReady: note("setReady") },
    document: { body: { classList: { add: note("obdone") } }, activeElement: null },
    window: {}, parent: { postMessage: note("postMessage") }, location: { origin: "http://x" },
    setTimeout: () => {},
  });
  vm.runInContext([
    QUESTION_SOURCE(),
    "let finished = false;",
    grab("  async function saveProfile(){", "  // ---- moving between cards"),
  ].join("\n"), context);
  await vm.runInContext(run, context);
  return { calls, onboard, finished: vm.runInContext("finished", context),
           empty: field => vm.runInContext("QUESTIONS", context).find(q => q.field === field).empty };
}

test("marking the last card done with an answer missing goes back to the first question unanswered", async () => {
  const names = calls => calls.map(c => c[0]);
  const all = { name: "Ada", email: "ada@example.org", work: "Research" };
  // the email or the work missing: that question again with its short line, and nothing saved
  for (const [field, given] of [["email", { name: "Ada" }], ["work", { name: "Ada", email: "ada@example.org" }]]) {
    const run = await finishWith({ name: null, email: null, work: null, ...given });
    assert.deepEqual(names(run.calls).filter(n => n === "fetch" || n === "postMessage"), [], "saved with no " + field);
    assert.equal(run.finished, false);
    assert.deepEqual(run.calls[0], ["show", 1], "not back on the onboarding card");
    assert.equal(run.onboard.asking, run.empty(field), "not the " + field + " question's own empty line");
    assert.equal(run.onboard.askingAt, 1, "not on the newest page");
    assert.deepEqual(run.calls.find(c => c[0] === "render"), ["render", "1:" + run.empty(field)]);
    assert.ok(names(run.calls).includes("printReply"), "the line is not shown");
  }
  // no name: the first question, as before, with no line put up
  const noName = await finishWith({ name: null, email: null, work: null });
  assert.deepEqual(names(noName.calls), ["show", "leaveHistory", "nudge"]);
  assert.equal(noName.onboard.asking, null);
  // everything given: saved, with the email and the yes
  const both = await finishWith(all);
  const save = both.calls.find(c => c[0] === "fetch");
  assert.equal(save[1], "/profile");
  assert.equal(save[2].email, "ada@example.org");
  assert.equal(save[2].emailYes, true);
  assert.equal(save[2].work, "Research");
  assert.equal("agent" in save[2], false, "the save still carries an agent");
  assert.equal(both.finished, true);
  assert.equal(both.onboard.asking, null);
});

test("the answers are saved as soon as the summary card is passed, so the bug on the last card has a name and email", async () => {
  const all = { name: "Ada", email: "ada@example.org", work: "Research" };
  const names = calls => calls.map(c => c[0]);
  // any move from the onboarding card to a card after it keeps the profile, and nothing else does
  assert.ok(ONBOARDING.includes("if (cards[at] === onboard && i > cards.indexOf(onboard)) keepProfile();"));
  // with every answer given: the same body finish saves, the feedback box woken, the board told
  const early = await finishWith(all, { run: "keepProfile()" });
  assert.deepEqual(names(early.calls), ["fetch", "setReady", "postMessage"]);
  assert.equal(early.calls[0][1], "/profile");
  assert.deepEqual(early.calls[1], ["setReady", true]);
  assert.deepEqual(out(early.calls[2].slice(1)), [{ onboarding: "saved" }, "http://x"]);
  assert.equal(early.finished, false, "the early save ended the run");
  const last = await finishWith(all);
  assert.deepEqual(early.calls[0][2], last.calls.find(c => c[0] === "fetch")[2], "not exactly what finish saves");
  // an answer missing, or a save the board refuses: nothing saved, or the box and the board are not told
  const lacking = await finishWith({ name: "Ada", email: "ada@example.org" }, { run: "keepProfile()" });
  assert.deepEqual(names(lacking.calls), []);
  const refused = await finishWith(all, { run: "keepProfile()", ok: false });
  assert.deepEqual(names(refused.calls), ["fetch"]);
  // the last card's done still saves, again, and ends the run
  const again = await finishWith(all, { run: "keepProfile().then(finish)" });
  assert.equal(names(again.calls).filter(n => n === "fetch").length, 2);
  assert.equal(again.finished, true);
});

// the page's guard on the done chord, cut out of the page and run in a vm with
// the board's own key table (card-logic.js), on stand ins for the keydowns
test("the done chord is kept from the browser on every card, in every field, held and once done", () => {
  const context = vm.createContext({ Date, setInterval, clearInterval, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), context, { filename: "card-logic.js" });
  const listeners = [];
  context.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  vm.runInContext(grab("  // the done chord, Control + Shift + Backspace or Delete", "  // the keys, read by the board's own table"), context);
  assert.equal(listeners.length, 1);
  const [guard] = listeners;
  assert.equal(guard.type, "keydown");
  // on the way down, so a field that stops its keys (the feedback sheet) still has it taken
  assert.equal(guard.capture, true);
  // the guard asks nothing of the card, the field or the run, so where the key lands cannot let it through
  const press = (key, code, more = {}) => {
    const e = { key, code, ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, repeat: false, isComposing: false,
                defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...more };
    guard.fn(e);
    return e;
  };
  for (const [key, code] of [["Backspace", "Backspace"], ["Delete", "Delete"]]) {
    assert.ok(press(key, code).defaultPrevented, key);
    assert.ok(press(key, code, { repeat: true }).defaultPrevented, key + " held");
    assert.ok(press(key, code, { isComposing: true }).defaultPrevented, key + " while composing");
    assert.ok(press(key, "", {}).defaultPrevented, key + " named only by the character");
  }
  // nothing else is taken: the chord with command or option, Backspace with one of the two, the other section chords
  for (const more of [{ metaKey: true }, { altKey: true }, { ctrlKey: false }, { shiftKey: false }])
    assert.equal(press("Backspace", "Backspace", more).defaultPrevented, false, JSON.stringify(more));
  for (const [key, code] of [["{", "BracketLeft"], ["}", "BracketRight"], ["|", "Backslash"], ["ArrowRight", "ArrowRight"]])
    assert.equal(press(key, code).defaultPrevented, false, key);
  // a chord already cancelled is still the board's done, so the last card marks itself done as before
  assert.deepEqual(out(context.cardShortcut(press("Backspace", "Backspace"))), { action: "sectionChord", value: "done" });
  assert.deepEqual(out(context.cardShortcut(press("Delete", "Delete"))), { action: "sectionChord", value: "done" });
  assert.ok(ONBOARDING.includes('if (key.value !== "done" || !card.spec.closing || finished) break;\n        e.preventDefault();\n        finish();'));
});

// the guard and the page's own key handler after it, cut out of the page and run
// in a vm with card-logic.js over the seven cards, on the page and in a field, and
// once the run is done. what the handler would do is recorded
test("Command + Shift + Backspace, Chrome's Delete browsing data on the Mac, is cancelled on every card and marks nothing done", () => {
  const context = vm.createContext({ Date, setInterval, clearInterval, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), context, { filename: "card-logic.js" });
  const handlers = [], calls = [];
  const note = name => (...args) => { calls.push(name); };
  // the guard is the window's, taken on the way down; the handler is the document's, after it
  context.addEventListener = (type, fn, capture) => { assert.equal(capture, true); handlers.push(fn); };
  Object.assign(context, { document: { addEventListener: (type, fn) => handlers.push(fn), activeElement: null },
    go: note("go"), advance: note("advance"), finish: note("finish"), stepHistory: note("stepHistory"),
    caretToTitleEnd: note("caretToTitleEnd") });
  const el = { ta: { focus: note("focus") }, titleEl: {} };
  context.cards = ["welcome", "onboard", "cards", "tickets", "hotkeys", "phone", "fin"].map(id =>
    ({ spec: { id, questions: id === "onboard", closing: id === "fin" }, el }));
  vm.runInContext("var at = 0, finished = false;\n" +
    grab("  // the done chord, Control + Shift + Backspace or Delete", "  // the feedback box, as the board's page has it"), context);
  assert.equal(handlers.length, 2);
  const page = { closest: () => null, blur() {} };
  const field = { closest: sel => (/textarea/.test(sel) ? field : null), blur() {} };
  const press = (target, key, code, more) => {
    calls.length = 0;
    const e = { key, code, target, ctrlKey: false, shiftKey: true, metaKey: false, altKey: false, repeat: false,
                isComposing: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...more };
    for (const fn of handlers) fn(e);
    return { prevented: e.defaultPrevented, calls: [...calls] };
  };
  for (const finished of [false, true]) for (let at = 0; at < context.cards.length; at++) {
    Object.assign(context, { at, finished });
    const where = context.cards[at].spec.id + (finished ? ", run done" : "");
    for (const target of [page, field]) {
      // Chrome's chord: cancelled, held or not, and nothing of the page's runs
      for (const repeat of [false, true])
        assert.deepEqual(press(target, "Backspace", "Backspace", { metaKey: true, repeat }), { prevented: true, calls: [] },
          "command + shift + backspace on " + where + (repeat ? ", held" : ""));
      // the done chord as before: cancelled everywhere, and marks the last card done until the run is done
      for (const [key, code] of [["Backspace", "Backspace"], ["Delete", "Delete"]])
        assert.deepEqual(press(target, key, code, { ctrlKey: true }),
          { prevented: true, calls: at === 6 && !finished ? ["finish"] : [] }, "control + shift + " + key + " on " + where);
      // the chords the board leaves to the field and to Chrome stay theirs: Command with Backspace or
      // Delete, and Command + Shift with the forward Delete, which is no shortcut of Chrome's
      for (const more of [{ shiftKey: false }, { shiftKey: false, key: "Delete", code: "Delete" }, { key: "Delete", code: "Delete" }])
        assert.deepEqual(press(target, "Backspace", "Backspace", { metaKey: true, ...more }), { prevented: false, calls: [] },
          JSON.stringify(more) + " on " + where);
    }
  }
});

test("the board keeps the onboarding up once the frame has saved the profile, until the frame says it is done", () => {
  const g = gate({ flag: true });
  const [frame] = g.frames;
  g.listeners.message({ source: frame.contentWindow, origin: "http://127.0.0.1:1", data: { onboarding: "saved" } });
  g.watch({});   // the profile now exists: the readings stop asking for the onboarding
  g.pass(5000);
  assert.equal(frame.gone, undefined, "the frame was taken away mid-run");
  assert.equal(g.document.body.inert, true);
  assert.ok(g.listeners.message, "the board stopped listening for done");
  // not another page's word for it
  const other = gate({ flag: true });
  other.listeners.message({ source: {}, origin: "http://127.0.0.1:1", data: { onboarding: "saved" } });
  other.watch({});
  other.pass(2100);
  assert.equal(other.frames[0].gone, true);
});

test("the onboarding is Welcome, one onboarding card of three needed questions, four 101 cards and You are all set up", () => {
  const titles = [...grab("  const CARDS = [", "  // the timings.").matchAll(/title: "([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(titles, ["Welcome!", "Let's onboard you onto the Facilitator!", "101: Atomizing asks",
                            "101: Tickets", "101: Hotkeys", "101: Phone App", "You are all set up"]);
  assert.doesNotMatch(ONBOARDING, /Orchestrator Agent|id: "orchestrator"/);
  // the questions are the onboarding card's replies, each tied to the field it fills, and each asks again when empty
  for (const [field, ask] of [["name", "What should we call you?"], ["email", "What's your email?"],
                              ["work", "What will you mostly use Facilitator for?"]])
    assert.match(ONBOARDING, new RegExp(`\\{ field: "${field}", ask: "${ask.replace("?", "\\?")}", noun: "[^"]+", empty: [A-Z]+_EMPTY`), field);
  assert.match(ONBOARDING, /\{ field: "email", [^}]*check: emailProblem \}/, "the email is not checked");
  assert.doesNotMatch(ONBOARDING, /EMAIL_ASK|go to PostHog|You can skip this one/);
  // the last page lights the step back and then the next card
  assert.match(ONBOARDING, /if \(!next\) after = \(\) => later\(\(\) => \{\s*const t = pulse\(\["ctrl", "shift", "up"\], LIGHT\);\s*later\(\(\) => pulse\(\["ctrl", "shift", "right"\], LIGHT\), t \+ LIGHTS_GAP_MS\);/);
  assert.doesNotMatch(ONBOARDING, /asideLater|BACK_ASIDE|ASIDE_ON|obheld/);
  assert.doesNotMatch(ONBOARDING, /#432BFF/i);
  assert.doesNotMatch(ONBOARDING, /—/, "an em dash");
  assert.doesNotMatch(ONBOARDING, /avatar|picture step|\.\.\/facilitator\//i);
  assert.doesNotMatch(ONBOARDING, /var\(--accent|purple|#7c3aed|#8b5cf6/i);
  for (const file of ["/card-markdown.js", "/card-logic.js", "/magic-box.js", "/card-tokens.css"])
    assert.ok(ONBOARDING.includes(file), file + " is not the board's own");
  assert.ok(ONBOARDING.includes('fetch("/onboarding/sample", { method: "POST" })'));
  assert.ok(ONBOARDING.includes('fetch("/profile", { method: "POST", body: JSON.stringify(body) })'));
  assert.ok(ONBOARDING.includes("emailYes: email != null"), "an email given is not the yes");
  assert.ok(ONBOARDING.includes('parent.postMessage({ onboarding: "done", project }, location.origin)'));
  assert.doesNotMatch(ONBOARDING, /placeholder\s*=\s*"[^"]*(\.\.\.|…)"/);
});

test("the cards say what they were given to say, with the board's own marks, on white", () => {
  const context = vm.createContext({});
  vm.runInContext(grab("  const key = name =>", "  // the timings.") +
    "\nObject.assign(this, { CARDS, MARK, HI, BLURB, WELCOME, NEXT });", context);
  const { CARDS, MARK, HI } = context;
  const say = id => CARDS.find(c => c.id === id).say;
  // the Welcome card: the lockup is the header, the word in a regular title's font (as it was in the
  // card's words before it moved), then the greeting as plain words, the blurb and the key, all to the left
  assert.equal(HI, "Hi there!");
  assert.equal(context.BLURB,
    "Facilitator is an opinionated and minimalist interface for interacting with claude or codex on the terminal.\n\n" +
    "Facilitator's UI is designed to help you ship more by atomizing your builds and orchestrating several subagents.");
  assert.equal(context.WELCOME, context.BLURB + "\n\nPress **→** to begin onboarding.");
  assert.ok(ONBOARDING.includes('el.titleEl.innerHTML = \'<span class="obbrand">'), "the lockup is not the header");
  assert.ok(ONBOARDING.includes('el.reply.dataset.raw = HI + "\\n\\n" + WELCOME;'));
  assert.ok(ONBOARDING.includes('el.reply.innerHTML = \'<div class="obwelcome">\' + fmt(el.reply.dataset.raw) + "</div>";'));
  assert.doesNotMatch(ONBOARDING, /obhi/, "the greeting has a look of its own");
  assert.match(ONBOARDING, /\.obwelcome\{display:flex; flex-direction:column; align-items:flex-start; text-align:left\}/);
  assert.match(ONBOARDING, /\.obbrand\{display:flex; width:max-content;/);
  assert.match(ONBOARDING, /\.obbrand\{[^}]*font:inherit; letter-spacing:-\.02em;/, "the word is not in the title's font");
  assert.doesNotMatch(ONBOARDING, /fitWelcome/, "the lockup is stretched to the header's width");
  // every card's key to go on says continue, a key's names in lower case where the sentence does not start with it
  assert.equal(context.NEXT, "Press **control\u00a0+\u00a0shift\u00a0+\u00a0→** to continue!");
  // the atomizing card, first of the 101 cards, in the words given: an orchestrator, and the names in lower case.
  // it goes on with the usual key
  assert.equal(say("cards"),
    "The only \"rule\" to make the best of the Facilitator is *atomize your asks.*\n\n" +
    "If you are building *n* features or solving *n* bugs or planning a spec with *n* phases, put them on *n* different cards!\n\n" +
    "The claude or codex agent connected to a project acts as an *orchestrator*. It assigns different tasks to different " +
    "subagents, which speeds up implementation. The orchestrator also retains a lot more context about a build session " +
    "than a single agent ever could.");
  assert.equal(CARDS[2].id, "cards");
  assert.ok(!CARDS[2].next, "the atomizing card has a key line of its own");
  // 101: Tickets, in the words and lists given, with the section chips' marks
  assert.equal(say("tickets"),
    "Cards are shown as a list of tickets on the left side.\n\n" +
    "Standard tickets have three states:\n\n- Yellow: Awaiting your input\n- Grey: Queued\n- Green: Actively working\n\n" +
    "And tickets can be put in four buckets:\n\n" +
    `- ${MARK.sun} Doing: Tasks you are actively working on\n- ${MARK.dock} Docked: Tasks that you will pick up very soon\n` +
    `- ${MARK.moon} Deferred: Tasks for some later coding sprint\n- ${MARK.cross} Done: Tasks that are complete\n\n` +
    "Bonus: after you iterate on a project for a while, tickets/cards act as a knowledge base for your projects.");
  // the marks are the top bar's own: the sun and the cloud from card-logic.js, the moon the chip's, the cross its bars
  assert.ok(ONBOARDING.includes("[MARK.sun]: '<span role=\"img\" class=\"obmark\" aria-label=\"sun\">' + SUN_ICON"));
  assert.ok(ONBOARDING.includes("[MARK.dock]: '<span role=\"img\" class=\"obmark\" aria-label=\"sun with cloud\">' + DOCK_ICON"));
  assert.ok(ONBOARDING.includes("[MARK.moon]: '<span role=\"img\" class=\"obmark\" aria-label=\"moon\">' + MOON_ICON"));
  assert.match(ONBOARDING, /\.reply \.obcross::before, \.reply \.obcross::after\{[^}]*width:var\(--bar-mark\); height:var\(--cross-t\); background:#1e1e1e/);
  assert.ok(ONBOARDING.includes("el.reply.innerHTML = withMarks(fmt(raw));"));
  // 101: Hotkeys: the words given, the hover tip and the basic keys as a list, a key's names in lower case but for
  // the first word of one that starts a list item. nothing on it lights on its own
  const hotkeys = CARDS.find(c => c.id === "hotkeys");
  const nb = s => s.replace(/ /g, "\u00a0");
  assert.equal(hotkeys.say, "The Facilitator \u2665\uFE0E hotkeys!\n\n" +
    "Pro-tip: hover your cursor over the bolded hotkeys\n\n" +
    "Here are some basic hotkeys:\n" +
    "- **←** and **→** switches cards\n" +
    "- **" + nb("Control + shift + ←/→") + "** switches cards when your cursor is in the compose box\n" +
    "- **" + nb("Shift + enter") + "** add a new line\n" +
    "- **" + nb("Command + T") + "** creates a new card\n" +
    "- Holding **" + nb("control + S") + "** scrolls the agent's answer down, or **" + nb("double tap S") +
    "** and hold it to scroll up\n" +
    "- To organize cards:\n" +
    `  - ${MARK.sun} Doing: **` + nb("Control + shift + [") + "**\n" +
    `  - ${MARK.dock} Docked: **` + nb("Control + shift + ]") + "**\n" +
    `  - ${MARK.moon} Deferred: **` + nb("Control + shift + \\\\") + "**\n" +
    `  - ${MARK.cross} Done: **` + nb("Control + shift + delete") + "**");
  assert.equal(hotkeys.lights, undefined, "101: Hotkeys lights its keys on its own");
  assert.doesNotMatch(ONBOARDING, /spec\.lights|LIGHTS_FROM_MS|HEART_ICON|MARK\.heart/);
  assert.doesNotMatch(say("hotkeys"), /\u2764|\uFE0F|<3/u, "the heart is the red emoji or a <3");
  // the keyboard at .7 of the hotkey map's, so it clears the ticket list, with the card's foot on the line
  // between its number row and its top letter row, so every letter shows
  assert.match(ONBOARDING, /--kb-scale:\.7; --kb-h:calc\(336px \* var\(--kb-scale\)\);\s*--kb-under:calc\(var\(--kb-h\) \* 96 \/ 336\);/);
  // the page stands on white
  assert.match(ONBOARDING, /body\{background:#fff\}/);
  // a key's name lights its keys while the pointer is over it, and the keys fade when it leaves
  assert.ok(ONBOARDING.includes('sections.addEventListener("pointerover", e => {'));
  assert.ok(ONBOARDING.includes('sections.addEventListener("pointerleave", () => hoverKeys([]));'));
  // the ticket list is drawn at no strength for two frames, then fades in over the .9s it had
  assert.match(ONBOARDING, /body\.focus\.obticketsprep #tickets\{visibility:visible; opacity:0;[^}]*\}/);
  assert.match(ONBOARDING, /body\.focus\.obtickets:not\(\.obdone\) #tickets\{transition:opacity \.9s ease, visibility 0s\}/);
  assert.ok(ONBOARDING.includes('list.add("obticketsprep");\n      requestAnimationFrame(() => requestAnimationFrame(() => {'));
});

test("101: Phone App holds his words with the photo of the phone app in the board's magic box beside it, and You are all set up, the last card, ends the run in the words it was given", () => {
  const context = vm.createContext({});
  vm.runInContext(grab("  const key = name =>", "  // the timings.") +
    "\nObject.assign(this, { CARDS, FINISH, PHONE_APP, NEXT, NEXT_PHONE, MARK });", context);
  const { CARDS, FINISH, PHONE_APP, NEXT, NEXT_PHONE, MARK } = context;
  const ids = CARDS.map(c => c.id);
  assert.deepEqual(out(ids.slice(-3)), ["hotkeys", "phone", "fin"], "101: Phone App and the last card do not follow 101: Hotkeys");
  // 101: Phone App: his paragraphs and his code block word for word, with no picture among them, and its key to go
  // on with the full stop it was given
  const phone = CARDS.find(c => c.id === "phone");
  assert.equal(phone.title, "101: Phone App");
  assert.equal(phone.say, PHONE_APP);
  assert.equal(PHONE_APP,
    "The Facilitator comes with a phone companion app!\n\n" +
    "The phone app is also hotkey-enabled and works as well as the mac version with a small keyboard, " +
    "allowing you to get work done even when you don't have your laptop!\n\n" +
    "Currently, the phone app connects to your Facilitator board on the laptop via **Tailscale**.\n\n" +
    "Once Tailscale is installed on your Mac and iPhone, setting up the phone app should take <5 minutes. " +
    "Just run the following on the terminal:\n\n" +
    "```\nfacilitator bridge setup\n```");
  assert.doesNotMatch(PHONE_APP, /Bonus|coming soon/i);
  assert.ok(!phone.closing, "101: Phone App ends the run");
  assert.equal(phone.next, NEXT_PHONE);
  assert.equal(NEXT_PHONE, "Press **control\u00a0+\u00a0shift\u00a0+\u00a0→** to continue.");
  // the code block's copy button is wired as the phone page wires it, and a press keeps the focus where it was
  assert.ok(ONBOARDING.includes("if (button) CardMarkdown.copyCodeBlock(button);"));
  assert.ok(ONBOARDING.includes('sections.addEventListener("mousedown", e => { if (e.target.closest?.(".copybtn")) e.preventDefault(); });'));
  assert.equal(MARK.picture, undefined, "the picture is a mark in the card's words");
  assert.doesNotMatch(ONBOARDING, /obpic/, "the photo has its slot in the card");
  // the picture: the photo of the phone app on its stand, with words for a screen reader, filling the magic box
  // as the board's picture in a box does
  assert.ok(ONBOARDING.includes(`const PHONE_IMAGE = '<img class="mbimg" src="/assets/phone_app_on_stand.webp" ' +\n` +
    `    'alt="The Facilitator phone app open on a phone on a stand, a keyboard in front of it">';`));
  assert.ok(ONBOARDING.includes("BOX.body.innerHTML = PHONE_IMAGE;"));
  // the box is the board's: the shared sheet's .magicbox with a bar and a picture's body, placed by magic-box.js
  // beside the card's own rectangle, out to the board's app frame and as clear of it as the board keeps
  assert.ok(ONBOARDING.includes('<script src="/magic-box.js"></script>'));
  assert.ok(ONBOARDING.includes('<section id="magicbox" class="magicbox">\n  <div class="mbbar"></div>\n' +
    '  <div class="mbbody" data-kind="image"></div>\n</section>'));
  assert.ok(MAC.includes("const FRAME_CLEAR = 16;") && ONBOARDING.includes("const FRAME_CLEAR = 16;   // index.html's"));
  assert.ok(ONBOARDING.includes("const fit = { scale: 1, tx: 0, right: innerWidth - inset - edge, clear: FRAME_CLEAR };"));
  assert.ok(ONBOARDING.includes("if (!photo.complete || !photo.naturalWidth || !MagicBox.place(rect, fit).shown){"));
  assert.ok(ONBOARDING.includes("MagicBox.place(rect, fit, { width: photo.naturalWidth + edges, height: photo.naturalHeight + edges,"));
  // the photo asks for what the board's view asks for a picture: its own size and the box's edges, the bar its head
  assert.ok(fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8")
    .includes("return w && h ? { width: w / scale + edges, height: h / scale + edges, head } : null;"));
  // it stands beside 101: Phone App and no other card, placed at every move and every resize
  assert.ok(ONBOARDING.includes('const PHOTO_ON = "phone";'));
  assert.ok(ONBOARDING.includes("const on = cards[at].spec.id === PHOTO_ON;\n    BOX.el.classList.toggle(\"on\", on);"));
  assert.ok(ONBOARDING.includes("    paintTickets();\n    // the photo's box beside its card, and nowhere else\n    placeBox();"));
  assert.ok(ONBOARDING.includes('addEventListener("resize", placeBox);'));
  // its face is the board's own, at full strength in the shadow of a box the board holds (.held), since nothing here
  // can hold it and the faint look of a box beside the card being worked in would wash the photo out
  const rule = (sheet, start) => { const at = sheet.indexOf(start); assert.ok(at >= 0, start); return sheet.slice(at, sheet.indexOf("}", at) + 1); };
  assert.equal(rule(ONBOARDING, "  #magicbox .mbbar::after{"), rule(MAC, "  #magicbox .mbbar::after{"));
  assert.ok(ONBOARDING.includes("#magicbox{background:var(--card); border:var(--edge) solid var(--line); border-radius:var(--mb-round);\n" +
    "    box-shadow:var(--shade-raised); opacity:1}"));
  assert.ok(MAC.includes(":is(#magicbox, #pipebox){background:var(--card); border:var(--edge) solid var(--line); border-radius:var(--mb-round);\n"));
  assert.ok(MAC.includes(":is(#magicbox, #pipebox).held{box-shadow:var(--shade-raised); opacity:1}"));
  const token = (sheet, name) => new RegExp(`${name}:([^;}]+)`).exec(sheet)[1].trim();
  assert.equal(token(ONBOARDING, "--shade-raised"), token(MAC, "--shade-raised"));
  assert.doesNotMatch(ONBOARDING, /--shade-lighter|--shade-unselected/, "the box wears the faint look");
  // the line under its bar is the card bar's own, as the board draws it under its box's bar (v0.2.508)
  assert.ok(ONBOARDING.includes("  #magicbox .mbbar{background:var(--card); box-shadow:inset 0 calc(-1 * var(--edge-drawn)) 0 var(--line)}"));
  assert.match(ONBOARDING, /body\.focus \.box\.sel \.topbar\{[^}]*box-shadow:inset 0 calc\(-1 \* var\(--edge-drawn\)\) 0 var\(--line\);/);
  // its two lines to the card are the board's: the svg before the card, its rules, and TWO, magicTwo and magicLine
  // word for word, taken off at every placing and drawn once the box is shown, as magicPlace does
  assert.ok(MAC.includes('<svg id="mbline" aria-hidden="true"></svg>'));
  assert.ok(ONBOARDING.includes('</section>\n<!-- the lines from the card to its magic box, two dashed lines beneath the\n' +
    '     card and the box: before the card on the page, so it is drawn over them -->\n' +
    '<svg id="mbline" aria-hidden="true"></svg>\n<div id="obstage">'));
  for (const start of ["  #mbline{", "  body.focus #mbline.on{", "  body.focus #mbline.on > g{"])
    assert.equal(rule(ONBOARDING, start), rule(MAC, start));
  const piece = (source, start, end) => { const at = source.indexOf(start); assert.ok(at >= 0, start); return source.slice(at, source.indexOf(end, at) + end.length); };
  const unindent = text => text.replace(/^  /gm, "");
  assert.ok(ONBOARDING.includes("\n  " + piece(MAC, "const TWO = {", "};") + "\n"));
  assert.equal(unindent(piece(ONBOARDING, "  function magicTwo(card, box){", "\n  }\n")), piece(MAC, "function magicTwo(card, box){", "\n}\n"));
  assert.equal(unindent(piece(ONBOARDING, "  function magicLine(card, box){", "\n  }\n")).replaceAll("BOX.line", "MB.line"),
    piece(MAC, "function magicLine(card, box){", "\n}\n"));
  assert.ok(MAC.includes('  MB.line.classList.remove("on");\n  const room = magicRoom();') && MAC.includes("  magicLine(rect, at);\n  boxRise(MB);"));
  assert.ok(ONBOARDING.includes('BOX.el.classList.toggle("on", on);\n    BOX.line.classList.remove("on");\n    if (!on) return;'));
  assert.ok(ONBOARDING.includes('height: seat.height + "px", visibility: "" });\n    // shown: its lines to the card\n    magicLine(rect, seat);\n  }'));
  // a plain lossy WebP, RIFF and one VP8 chunk with nothing after it, so it holds no Exif, XMP or ICC chunk
  const picture = fs.readFileSync(path.join(ROOT, "assets", "phone_app_on_stand.webp"));
  assert.equal(picture.toString("latin1", 0, 4) + picture.toString("latin1", 8, 16), "RIFFWEBPVP8 ");
  const size = picture.readUInt32LE(16);
  assert.equal(20 + size + (size & 1), picture.length, "the file holds a chunk besides the picture");
  const shape = [picture.readUInt16LE(26) & 0x3fff, picture.readUInt16LE(28) & 0x3fff];
  assert.deepEqual(shape, [854, 949]);
  // the box takes the file's own shape, so none of it is cut
  assert.doesNotMatch(ONBOARDING, /object-fit/, "the picture is fitted to a box of another shape");
  assert.ok(ONBOARDING.includes("html.replace(/[\\uE001-\\uE005]/g, c => MARKS[c])"));
  assert.equal(NEXT, "Press **control\u00a0+\u00a0shift\u00a0+\u00a0→** to continue!");
  // the last card, in his paragraphs, three stars centred as a divider, and the done key written the way the cards write a key
  const fin = CARDS.find(c => c.id === "fin");
  assert.equal(fin.title, "You are all set up");
  assert.equal(fin.say,
    "Thank you for trying out the facilitator!\n\n" +
    "If you encounter bugs or have feedback, please use the bug button on the top-right corner.\n\n" +
    "Your ideas could be instrumental in shaping this product!\n\n" + MARK.stars);
  assert.ok(ONBOARDING.includes("[MARK.stars]: '<span class=\"obstars\" role=\"separator\">* * *</span>',"));
  assert.match(ONBOARDING, /\.reply \.obstars\{display:block; text-align:center;/);
  assert.equal(FINISH, "Press **control\u00a0+\u00a0shift\u00a0+\u00a0backspace** to mark this card done and open your board.");
  assert.doesNotMatch(fin.say, /\{meta|arrow/i, "the meta note is on the card");
  // only the last card ends the run: the done key, the cross and the jump to the card waiting longest all go to it
  assert.deepEqual(out(CARDS.filter(c => c.closing).map(c => c.id)), ["fin"]);
  assert.ok(ONBOARDING.includes('render(el, [spec.say, spec.closing ? FINISH : spec.next || NEXT].join("\\n\\n"));'));
  assert.ok(ONBOARDING.includes('if (spec.closing) el.x.addEventListener("click", finish);'));
  assert.ok(ONBOARDING.includes("cards.find(c => c.spec.closing)"));
  // the Hotkeys card does not call itself the last card or the way to finish
  assert.doesNotMatch(CARDS.find(c => c.id === "hotkeys").say, /last card|finish|open your board/i);
});

// the board's three top-right buttons on FIN
test("the last card shows the board's speaker, bug and squid buttons, the speaker and squid dimmed and the bug at full strength", () => {
  const rule = sel => {
    const at = ONBOARDING.indexOf(sel + "{");
    assert.ok(at >= 0, "no rule for " + sel);
    return ONBOARDING.slice(at, ONBOARDING.indexOf("}", at));
  };
  // no arrow is left
  assert.doesNotMatch(ONBOARDING, /obarrow|placeArrow|ARROW_ON|BUG_AT/);
  // the three buttons are the board's own markup, in the board's order
  const bar = ONBOARDING.match(/<div id="obbar">[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...bar.matchAll(/<button id="(\w+)"/g)].map(m => m[1]), ["obchime", "obbug", "obset"]);
  const glyph = (html, id) => html.match(new RegExp('<button id="' + id + '"[\\s\\S]*?</button>'))[0].replace(/^<button[^>]*>/, "");
  assert.equal(glyph(bar, "obchime"), glyph(MAC, "chimebtn"), "the speaker is not the board's");
  assert.equal(glyph(bar, "obbug"), glyph(MAC, "feedbackbtn"), "the bug is not the board's");
  assert.equal(glyph(bar, "obset"), glyph(MAC, "setbtn"), "the squid is not the board's");
  assert.equal([...bar.matchAll(/class="qn-glass"/g)].length, 3, "not all three in the board's glass");
  // greyed and not pressable: the speaker and the squid are disabled and dimmed, the bug is neither
  const button = id => bar.match(new RegExp('<button id="' + id + '"[^>]*>'))[0];
  assert.match(button("obchime"), /\bdisabled\b/);
  assert.match(button("obset"), /\bdisabled\b/);
  assert.doesNotMatch(button("obbug"), /\bdisabled\b|aria-disabled/);
  assert.equal(rule("#obbar button:disabled"), "#obbar button:disabled{opacity:.4; cursor:default");
  assert.doesNotMatch(rule("#obbar button"), /opacity/, "the bug is dimmed too");
  // where the board's bar puts them: its inset, 40px height with 1px and 6px padding, 8px gap, 32px circles,
  // and 3px more before the bug and the squid
  assert.ok(MAC.includes("body.focus .bar{height:40px; padding:1px 0 6px; gap:8px}"));
  assert.ok(MAC.includes("body.focus .bar :is(#chimebtn, #feedbackbtn, #setbtn){margin-left:3px}"));
  assert.match(MAC, /body\.focus :is\(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn\)\{\s*flex:none; position:relative; box-sizing:border-box; width:32px; height:32px;/);
  assert.match(rule("#obbar"), /position:fixed; top:var\(--app-inset\); right:var\(--app-inset\); height:40px; padding:1px 0 6px;\s*border-bottom:1px solid transparent; display:flex; align-items:center; gap:8px;/);
  assert.ok(MAC.includes("border-bottom-color:transparent; border-bottom-width:1px;"), "the board's bar lost its clear bottom row");
  assert.match(rule("#obbar button"), /width:32px; height:32px;[^}]*border-radius:50%/);
  assert.equal(rule("#obbar #obbug, #obbar #obset"), "#obbar #obbug, #obbar #obset{margin-left:3px");
  // the board's bar glass: the same shadow stack
  const stack = css => css.slice(css.indexOf("box-shadow:")).split("}")[0].replace(/\s+/g, " ").trim();
  const boardGlass = MAC.slice(MAC.indexOf("body.focus :is(.bar .qn-glass, #projmenu)"));
  assert.equal(stack(rule("#obbar .qn-glass")), stack(boardGlass));
  // shown on FIN only (the last card), gently, and kept through its done so the corner is never empty while the board opens
  assert.ok(ONBOARDING.includes('document.body.classList.toggle("obfin", !!card.spec.closing);'));
  assert.match(rule("#obbar"), /opacity:0; visibility:hidden; pointer-events:none;/);
  assert.equal(rule("body.obfin #obbar"), "body.obfin #obbar{opacity:1; visibility:visible; pointer-events:auto; transition:opacity .9s ease, visibility 0s");
  assert.doesNotMatch(ONBOARDING, /obdone[^{]*#obbar|#obbar[^{]*obdone/);
  const sheet = ONBOARDING.slice(ONBOARDING.indexOf("#obbar{"), ONBOARDING.indexOf("</style>", ONBOARDING.indexOf("#obbar{")));
  assert.doesNotMatch(sheet, /animation|infinite|blink|@keyframes/, "the buttons move on their own");
  // the bug opens the Share Feedback sheet (the profile is saved once the summary card is passed), the box is the
  // board's own, and a press keeps the page's keys
  assert.ok(ONBOARDING.includes('const feedbackSheet = feedbackOverlay(document.body, document.getElementById("fbbox").closest(".fbrow"), {});'));
  assert.ok(ONBOARDING.includes('document.getElementById("obbug").addEventListener("click", () => feedbackSheet.open());'));
  assert.ok(ONBOARDING.includes('send: text => fetch("/feedback", { method: "POST", body: JSON.stringify({ message: text }) })'));
  const row = html => html.match(/<div class="setrow fbrow">[\s\S]*?<small id="fbnote"[^>]*><\/small>/)[0].replace(/\s+/g, " ");
  assert.equal(row(ONBOARDING), row(MAC), "the feedback row is not the board's");
  assert.ok(ONBOARDING.includes('document.getElementById("obbug").addEventListener("mousedown", e => e.preventDefault());'));
  assert.match(button("obbug"), /tabindex="-1"/);
});

// the onboarding card's pages as the page writes them, run in a vm
test("the way to change an answer is said once, on the last page, under the answers", () => {
  const context = vm.createContext({ HINT: "reply" });
  vm.runInContext([
    grab("  function plain(text){", "  // the answer a message gives"),
    grab("  const key = name =>", "  // the timings."),
    "const profile = { name: 'Ada', email: 'ada@example.org', work: 'Research', timeZone: null };",
    grab("  function pageRaw(card, i){", "  // every card's words were written"),
    "this.pageRaw = pageRaw; this.BACK_LINE = BACK_LINE; this.MARK = MARK;",
  ].join("\n"), context);
  const back = "To change any of the previous answers, press **control + shift + ↑**";
  assert.equal(context.BACK_LINE, back);
  const card = { asking: null, askingAt: null,
                 pages: ["name", "email", "work", null].map((field, i) => ({ field, head: i ? "Got it." : null })) };
  const pages = card.pages.map((p, i) => context.pageRaw(card, i));
  for (const raw of pages.slice(0, -1)) assert.doesNotMatch(raw, /change|control.shift.↑/i, "a question page says how to change an answer");
  const last = pages.at(-1);
  assert.equal(last.split(back).length, 2, "the last page does not say it exactly once");
  assert.ok(last.indexOf("Here is what you told us:") < last.indexOf(back), "the line is not under the answers");
  // the key to go on stands under the last card's three stars
  assert.ok(last.endsWith(back + "\n\n" + context.MARK.stars + "\n\n" +
    "If the entered information looks correct, press **control\u00a0+\u00a0shift\u00a0+\u00a0→** to continue!"));
});

// the page's own moves between cards, run in a vm with the page around them stubbed
function moves({ at = 1, answers = {}, pending = [] } = {}) {
  const calls = [];
  const note = name => (...args) => { calls.push([name, ...args]); };
  const onboard = { spec: { id: "onboard" }, asking: null, askingAt: null, el: { onboard: true }, pending, pages: [{}, {}] };
  const cards = [{ spec: { id: "welcome" } }, onboard, { spec: { id: "cards" } }, { spec: { id: "tickets" } }, { spec: { id: "hotkeys" } },
                 { spec: { id: "phone" } }, { spec: { id: "fin" } }];
  const context = vm.createContext({
    calls, onboard, cards, profile: { name: null, email: null, work: null, ...answers },
    show: note("show"), leaveHistory: note("leaveHistory"), printReply: note("printReply"),
    render: (el, raw) => calls.push(["render", raw]), pageRaw: (card, i) => i + ":" + card.asking,
  });
  vm.runInContext([
    QUESTION_SOURCE(),
    `let at = ${at}, finished = false, select;`,
    grab("  function blocked(i){", "  // Control + Shift + Enter: the card"),
    grab("  select = id => {", "  // the onboarding always opens on Doing"),
    "this.go = go; this.select = select; this.empty = f => QUESTIONS.find(q => q.field === f).empty;",
  ].join("\n"), context);
  return { calls, onboard, go: context.go, select: context.select, empty: context.empty };
}

test("the cards after the onboarding card open only once every question is answered", () => {
  const all = { name: "Ada", email: "ada@example.org", work: "Research" };
  // the Welcome card to the onboarding card is free
  const welcome = moves({ at: 0 });
  welcome.go(1);
  assert.deepEqual(out(welcome.calls), [["show", 1]]);
  // a step on, or a click on a later card's ticket, with a question unanswered: the card stays, and asks for that answer
  for (const [field, answers] of [["name", {}], ["email", { name: "Ada" }], ["work", { name: "Ada", email: "ada@example.org" }]]) {
    for (const move of [m => m.go(1), m => m.select("cards"), m => m.select("hotkeys")]) {
      const m = moves({ answers });
      move(m);
      assert.ok(!m.calls.some(c => c[0] === "show"), "moved on without the " + field);
      assert.equal(m.onboard.asking, m.empty(field));
      assert.equal(m.onboard.askingAt, 1, "not on the newest page");
      assert.deepEqual(out(m.calls.find(c => c[0] === "render")), ["render", "1:" + m.empty(field)]);
      assert.ok(m.calls.some(c => c[0] === "printReply"), "the line is not shown");
    }
  }
  // the last answer still on its way in: held back, with no line
  const landing = moves({ answers: { name: "Ada", email: "ada@example.org" }, pending: [{}] });
  landing.go(1);
  assert.deepEqual(out(landing.calls), []);
  // every answer in: the next card, and back to the Welcome card, as before
  const done = moves({ answers: all });
  done.go(1);
  done.go(-1);
  done.select("hotkeys");
  done.select("fin");
  assert.deepEqual(out(done.calls), [["show", 2], ["show", 0], ["show", 4], ["show", 6]]);
  // backwards is never held
  const back = moves({});
  back.go(-1);
  assert.deepEqual(out(back.calls), [["show", 0]]);
});

// the hover's reading of a key's name, run in a vm on small stand ins for the
// reply's bold words
test("a key's name on a card reads as the keys the keyboard lights", () => {
  const context = vm.createContext({});
  vm.runInContext(grab("  const KEY_NAMES = ", "  let hovered = [];") + "\nthis.keysFor = chip => JSON.stringify(chipKeys(chip));", context);
  const keysOf = chip => JSON.parse(context.keysFor(chip));
  const b = text => ({ nodeName: "B", nodeType: 1, textContent: text, previousSibling: null });
  const after = (chord, words, text) => {
    const lead = b(chord), between = { nodeType: 3, data: words, previousSibling: lead }, chip = b(text);
    chip.previousSibling = between;
    return chip;
  };
  const nb = s => s.replace(/ /g, " ");
  assert.deepEqual(keysOf(b(nb("Command + T"))), ["cmd", "t"]);
  assert.deepEqual(keysOf(b(nb("Control + Shift + Backspace"))), ["ctrl", "shift", "delete"]);
  assert.deepEqual(keysOf(b(nb("Control + Shift + Enter"))), ["ctrl", "shift", "return"]);
  assert.deepEqual(keysOf(b("Tab")), ["tab"]);
  assert.deepEqual(keysOf(b("→")), ["right"]);
  assert.deepEqual(keysOf(after(nb("Control + Shift + ←"), " and ", "→")), ["ctrl", "shift", "right"]);
  assert.deepEqual(keysOf(after(nb("Control + Shift + ↑"), " and ", "↓")), ["ctrl", "shift", "down"]);
  assert.deepEqual(keysOf(after(nb("Control + Shift + ↑"), " step ", "↓")), ["down"]);
  // a run of lone keys after a chord, joined by commas and an "and", each lights with the chord
  const run = (chord, ...rest) => {
    let at = b(chord);
    for (let i = 0; i < rest.length; i += 2) {
      const between = { nodeType: 3, data: rest[i], previousSibling: at }, chip = b(rest[i + 1]);
      chip.previousSibling = between;
      at = chip;
    }
    return at;
  };
  assert.deepEqual(keysOf(b(nb("Control + Shift + ["))), ["ctrl", "shift", "["]);
  assert.deepEqual(keysOf(run(nb("Control + Shift + ["), ", ", "]")), ["ctrl", "shift", "]"]);
  assert.deepEqual(keysOf(run(nb("Control + Shift + ["), ", ", "]", ", ", "\\")), ["ctrl", "shift", "\\"]);
  assert.deepEqual(keysOf(run(nb("Control + Shift + ["), ", ", "]", ", ", "\\", " and ", "Delete")), ["ctrl", "shift", "delete"]);
  assert.deepEqual(keysOf(run("←", " and ", "→")), ["right"]);
  assert.deepEqual(keysOf(b(nb("Control + S"))), ["ctrl", "s"]);
  assert.deepEqual(keysOf(b(nb("Shift + Enter"))), ["shift", "return"]);
  // two keys written as one both light, and a double tap lights the chord written before it with that key
  assert.deepEqual(keysOf(b(nb("Control + shift + ←/→"))), ["ctrl", "shift", "left", "right"]);
  assert.deepEqual(keysOf(after(nb("control + S"), " scrolls the agent's answer down, or ", nb("double tap S"))), ["ctrl", "s"]);
  assert.deepEqual(keysOf(b("double tap S")), ["s"]);
  assert.deepEqual(keysOf(b("not a key")), []);
});

test("the board lays the onboarding over itself while the server says so, and takes it away when it ends", () => {
  const gate = MAC.slice(MAC.indexOf("if (globalThis.BOARD_ONBOARDING) openOnboarding();"), MAC.indexOf("\nfunction showOwnerRefusal"));
  assert.ok(gate.startsWith("if (globalThis.BOARD_ONBOARDING) openOnboarding();"), "the board never asks");
  assert.ok(gate.includes('frame.src = "/onboarding";'));
  assert.ok(gate.includes("document.documentElement.appendChild(frame);\n  document.body.inert = true;"),
            "the board under the onboarding can still be used");
  assert.ok(gate.includes('e.data?.onboarding !== "done"') && gate.includes("e.origin !== location.origin"));
  assert.match(gate, /if \(tabClosed\(project\)\) reopenTab\(project\);\s*else setTab\(project\);/);
  assert.ok(gate.includes('if (!frame.contentDocument?.getElementById("obstage")){ onboard.failed = true; away(); }'),
            "a frame without the onboarding would wall the board off");
  const reading = MAC.slice(MAC.indexOf("async function poll(timed = false){"), MAC.indexOf("if (seq <= createSeq) return;"));
  assert.ok(reading.startsWith("async function poll("), "the board's reading was not found");
  assert.match(reading, /try \{ onboardingWatch\(state\); \} catch \(e\) \{/,
               "a reading of the board never asks whether the onboarding is needed");
  assert.match(MAC, /#onboard\{position:fixed; inset:0;[^}]*z-index:2147483647;[^}]*transition:opacity \.18s ease\}/);
});

// the board's own gate code, run in a vm with the window, the document and the
// board's tab moves replaced by small fakes and the clock handed in
function gate({ flag = false } = {}) {
  const frames = [], timers = [], listeners = {}, moves = [];
  let now = 1000;
  const frameOf = () => {
    const self = { id: "", title: "", src: "", classList: { add: c => { self.gone = c === "gone"; } }, events: {},
      removed: false, contentWindow: { focus() {} }, contentDocument: null,
      addEventListener(type, fn) { this.events[type] = fn; }, remove() { this.removed = true; } };
    return self;
  };
  const document = { body: { inert: false }, createElement: () => { const f = frameOf(); frames.push(f); return f; },
                     documentElement: { appendChild() {} } };
  const context = vm.createContext({
    document, globalThis: { BOARD_ONBOARDING: flag }, location: { origin: "http://127.0.0.1:1" },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; },
    poll: async () => {}, validActiveOwnerIds: new Set(["facilitator-sample"]), tabClosed: () => false,
    setTab: id => moves.push(id), reopenTab: id => moves.push("reopen " + id),
  });
  const block = MAC.slice(MAC.indexOf("const onboard = {"), MAC.indexOf("\nfunction showOwnerRefusal"));
  vm.runInContext(block, context);
  return {
    frames, moves, listeners, document,
    watch: (state, asked = now) => vm.runInContext("onboardingWatch", context)({ ...state, fetchedAt: asked }),
    pass(ms) { now += ms; for (const t of timers) if (!t.cleared && !t.ran && t.at <= now) { t.ran = true; t.fn(); } },
    get now() { return now; },
  };
}

test("a page that loaded without the flag puts the onboarding up from its next reading, once", () => {
  const g = gate();
  assert.equal(g.frames.length, 0);
  g.watch({ onboarding: true });
  assert.equal(g.frames.length, 1, "the reading did not put the onboarding up");
  assert.equal(g.frames[0].src, "/onboarding");
  assert.equal(g.document.body.inert, true);
  g.watch({ onboarding: true });
  g.watch({ onboarding: true });
  assert.equal(g.frames.length, 1, "every reading opened another frame");
  const loaded = gate({ flag: true });
  assert.equal(loaded.frames.length, 1, "the flag at load no longer puts it up");
  loaded.watch({ onboarding: true });
  assert.equal(loaded.frames.length, 1);
});

test("the onboarding goes two seconds after the board stops asking, and a reading older than that is not believed", () => {
  const g = gate({ flag: true });
  const [frame] = g.frames;
  g.watch({});
  g.pass(1900);
  assert.equal(frame.gone, undefined, "it went before this window's own closing card could name a project");
  g.watch({ onboarding: true });   // still asked for: the leaving is called off
  g.pass(3000);
  assert.equal(frame.gone, undefined);
  g.watch({});
  g.pass(2100);
  assert.equal(frame.gone, true, "a profile saved in another window left this one walled off");
  assert.equal(g.document.body.inert, false);
  g.watch({ onboarding: true }, g.now - 50);   // asked before it ended
  assert.equal(g.frames.length, 1, "a stale reading put it back up");
  g.pass(10);
  g.watch({ onboarding: true }, g.now);       // the profile went missing again since
  assert.equal(g.frames.length, 2);
});

test("a frame that did not get the onboarding is taken away and not put up again by that page", () => {
  const g = gate({ flag: true });
  g.frames[0].events.load();   // no #obstage in it
  assert.equal(g.frames[0].gone, true);
  assert.equal(g.document.body.inert, false);
  g.watch({ onboarding: true });
  assert.equal(g.frames.length, 1, "a broken onboarding was put up again every second");
});

test("the Profile section is in Settings on the Mac, editable, and on the phone, shown", () => {
  const mac = MAC.slice(MAC.indexOf('<div data-section="profile" data-label="Profile">'), MAC.indexOf('<div data-section="appearance"'));
  for (const id of ["setname", "setemail", "setwork", "settz"])
    assert.ok(mac.includes(`id="${id}"`), id);
  assert.doesNotMatch(mac, /setagent|Main agent/i, "the Mac's Profile still has a main agent");
  // no switch and no subtitles: the email is the yes, and clearing it takes the yes back
  assert.doesNotMatch(mac, /setemailyes|Feedback emails|role="switch"|sethelp|avatar/i);
  // the picture: an empty square the page fills from the board's stored number, one of twelve drawings, 19 to 30
  assert.match(mac, /<div class="setpic" id="setpic" aria-hidden="true"><\/div>/);
  // the twelve drawings and the time zone's words are the shared page's, in card-logic.js, for the Mac and the phone
  const LOGIC = fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
  const drawings = LOGIC.slice(LOGIC.indexOf("const SETTINGS_PICTURES = {"), LOGIC.indexOf("function settingsZoneWords"));
  assert.deepEqual([...drawings.matchAll(/^\s+(\d+): '/gm)].map(m => m[1]), Array.from({ length: 12 }, (_, i) => String(19 + i)));
  assert.doesNotMatch(drawings, /setmono|&gt;_/, "the old prompt is still drawn");
  assert.doesNotMatch(MAC, /const PICTURES = |const zoneWords/, "the Mac page keeps its own copy");
  assert.ok(MAC.includes("if (SETTINGS_PICTURES[p.picture]) picture.innerHTML = SETTINGS_PICTURES[p.picture];"));
  assert.doesNotMatch(mac, /setpic[^>]*>[^<]*<(?!\/div)/, "the square holds something before a picture is read");
  assert.doesNotMatch(MAC.slice(MAC.indexOf("const profileFields"), MAC.indexOf("const view = settingsOverlay")), /picture:/,
    "the page sends a picture");
  assert.ok(MAC.includes('const change = { [key]: input.value };'));
  assert.ok(MAC.includes('if (key === "email") change.emailYes = input.value.trim() !== "";'));
  assert.ok(MAC.includes('fetch("/profile", { method: "POST", body: JSON.stringify({ ...change, timeZone: hereZone() }) })'));
  const phone = PHONE.slice(PHONE.indexOf('<div data-section="profile" data-label="Profile">'), PHONE.indexOf('<div data-section="appearance"'));
  for (const id of ["pfpic", "pfname", "pfemail", "pfwork", "pftz"]) assert.ok(phone.includes(`id="${id}"`), id);
  assert.doesNotMatch(phone, /pfagent|Main agent/i, "the phone's Profile still has a main agent");
  assert.doesNotMatch(phone, /<input/, "the phone writes the profile");
  // the phone's Profile is the Mac's: the picture beside the name and email with no label, no feedback switch or
  // status, no note and no subtitles, and the picture and the time zone drawn by the shared code
  assert.doesNotMatch(phone, /pfyes|Feedback emails|sethelp|setnote|avatar/i);
  assert.match(phone, /<div class="setpic" id="pfpic" aria-hidden="true" hidden><\/div>/);
  assert.ok(PHONE.includes("settingsZoneWords(p.timeZone)") && PHONE.includes("SETTINGS_PICTURES[p.picture]"));
  assert.doesNotMatch(mac + phone, /--accent|purple/);
});
