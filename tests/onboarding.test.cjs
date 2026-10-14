// The onboarding, end to end on a whole board copied into a throwaway folder,
// with a throwaway home and no browser: a board with no profile tells its page
// to put the onboarding up, serves the onboarding for its own origin to frame,
// makes the sample project in the home folder, takes the profile the closing
// card saves, and from then on opens as a board. With an email given, the
// email and the answers reach PostHog's capture API once, which here is a
// listener on this machine: the copied usage_counts.py is pointed at it, so
// nothing can reach the real PostHog. The page files are read for what the
// onboarding and the Profile section say. Nothing here touches port 8877.
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

// PostHog's capture API, as far as the board's sender needs it: every body kept
async function fakePostHog() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => { bodies.push({ path: req.url, body: JSON.parse(raw) }); res.end("{\"status\": 1}"); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { bodies, url: `http://127.0.0.1:${server.address().port}/i/v0/e/`, close: () => new Promise(r => server.close(r)) };
}

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
    extra: ["onboarding.html"],
    env: { HOME: home },
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
                    work: "A research tool for my lab", agent: "Claude Code", timeZone: "America/Phoenix" };
  const saved = await board.call("POST", "/profile", JSON.stringify(answers));
  assert.equal(saved.status, 200, saved.text);
  assert.equal(json(saved).sent, true);
  assert.equal(posthog.bodies.length, 1);
  const [identify] = posthog.bodies;
  assert.equal(identify.path, "/i/v0/e/");
  assert.equal(identify.body.event, "$identify");
  assert.deepEqual(identify.body.properties, { $geoip_disable: true, $set: {
    email: "ada@example.org", name: "Ada Lovelace", work: "A research tool for my lab",
    main_agent: "Claude Code", time_zone: "America/Phoenix" } });
  const install = JSON.parse(fs.readFileSync(path.join(board.app, "usage-install.json"), "utf8"));
  assert.equal(identify.body.distinct_id, install.install_id);
  const kept = JSON.parse(fs.readFileSync(path.join(board.app, "profile.json"), "utf8"));
  assert.deepEqual(kept, { name: "Ada Lovelace", email: "ada@example.org", email_yes: true,
                           work: "A research tool for my lab", agent: "Claude Code", time_zone: "America/Phoenix",
                           picture: null });   // drawn by the first page that needs it, never sent
  assert.equal(fs.statSync(path.join(board.app, "profile.json")).mode & 0o777, 0o600);

  // an edit in Settings while the yes holds goes once, alone; the yes taken back sends nothing more
  await board.call("POST", "/profile", JSON.stringify({ work: "Teaching", timeZone: "America/Phoenix" }));
  assert.deepEqual(posthog.bodies[1].body.properties, { $geoip_disable: true, $set: { work: "Teaching" } });
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
  grab("  const AGENTS = ", "  // the replies that carry"),
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
  assert.deepEqual(out(QUESTIONS.map(q => q.field)), ["name", "email", "work", "agent"]);
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
  assert.equal(lines.size, 4, "two questions ask for their answer with the same line");
  // an answer goes through, and only the email is checked beyond being there
  for (const [field, text] of [["name", "Ada"], ["email", "ada@example.org"], ["work", "Research"], ["agent", "2"]]) {
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

// the page's own finish() (the done chord and the cross of 101: Hotkeys both call it), run in a vm with
// the page around it stubbed: the card moves and the save are recorded. No browser.
async function finishWith(answers) {
  const calls = [];
  const note = name => (...args) => { calls.push([name, ...args]); };
  const onboard = { asking: null, askingAt: null, el: { onboard: true }, pages: [{}, {}] };
  const context = vm.createContext({
    calls, onboard, cards: [{}, onboard], profile: { timeZone: null, ...answers },
    show: note("show"), leaveHistory: note("leaveHistory"), nudge: note("nudge"), printReply: note("printReply"),
    render: (el, raw) => calls.push(["render", raw]), pageRaw: (card, i) => i + ":" + card.asking,
    unlight: note("unlight"), caretQueue: note("caretQueue"), projectReady: Promise.resolve(null),
    fetch: async (url, init) => { calls.push(["fetch", url, JSON.parse(init.body)]); return { ok: true }; },
    document: { body: { classList: { add: note("obdone") } }, activeElement: null },
    window: {}, parent: { postMessage: note("postMessage") }, location: { origin: "http://x" },
    setTimeout: () => {},
  });
  vm.runInContext([
    QUESTION_SOURCE(),
    "let finished = false, saving = false;",
    grab("  async function finish(){", "  // ---- moving between cards"),
  ].join("\n"), context);
  await vm.runInContext("finish()", context);
  return { calls, onboard, finished: vm.runInContext("finished", context),
           empty: field => vm.runInContext("QUESTIONS", context).find(q => q.field === field).empty };
}

test("marking the last card done with an answer missing goes back to the first question unanswered", async () => {
  const names = calls => calls.map(c => c[0]);
  const all = { name: "Ada", email: "ada@example.org", work: "Research", agent: "Codex" };
  // the email, the work or the agent missing: that question again with its short line, and nothing saved
  for (const [field, given] of [["email", { name: "Ada" }], ["work", { name: "Ada", email: "ada@example.org" }],
                                ["agent", { name: "Ada", email: "ada@example.org", work: "Research" }]]) {
    const run = await finishWith({ name: null, email: null, work: null, agent: null, ...given });
    assert.deepEqual(names(run.calls).filter(n => n === "fetch" || n === "postMessage"), [], "saved with no " + field);
    assert.equal(run.finished, false);
    assert.deepEqual(run.calls[0], ["show", 1], "not back on the onboarding card");
    assert.equal(run.onboard.asking, run.empty(field), "not the " + field + " question's own empty line");
    assert.equal(run.onboard.askingAt, 1, "not on the newest page");
    assert.deepEqual(run.calls.find(c => c[0] === "render"), ["render", "1:" + run.empty(field)]);
    assert.ok(names(run.calls).includes("printReply"), "the line is not shown");
  }
  // no name: the first question, as before, with no line put up
  const noName = await finishWith({ name: null, email: null, work: null, agent: null });
  assert.deepEqual(names(noName.calls), ["show", "leaveHistory", "nudge"]);
  assert.equal(noName.onboard.asking, null);
  // everything given: saved, with the email and the yes
  const both = await finishWith(all);
  const save = both.calls.find(c => c[0] === "fetch");
  assert.equal(save[1], "/profile");
  assert.equal(save[2].email, "ada@example.org");
  assert.equal(save[2].emailYes, true);
  assert.equal(save[2].work, "Research");
  assert.equal(save[2].agent, "Codex");
  assert.equal(both.finished, true);
  assert.equal(both.onboard.asking, null);
});

test("the onboarding is Welcome, one onboarding card of four needed questions, and three 101 cards", () => {
  const titles = [...grab("  const CARDS = [", "  // the timings.").matchAll(/title: "([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(titles, ["Welcome!", "Let's onboard you onto the Facilitator!", "101: Cards & atomizing ideas",
                            "101: Tickets", "101: Hotkeys"]);
  assert.doesNotMatch(ONBOARDING, /Orchestrator Agent|id: "orchestrator"/);
  // the questions are the onboarding card's replies, each tied to the field it fills, and each asks again when empty
  for (const [field, ask] of [["name", "What should we call you?"], ["email", "What's your email?"],
                              ["work", "What will you mostly use Facilitator for?"], ["agent", "Which agent do you use most?"]])
    assert.match(ONBOARDING, new RegExp(`\\{ field: "${field}", ask: "${ask.replace("?", "\\?")}", noun: "[^"]+", empty: [A-Z]+_EMPTY`), field);
  assert.match(ONBOARDING, /\{ field: "email", [^}]*check: emailProblem \}/, "the email is not checked");
  assert.doesNotMatch(ONBOARDING, /EMAIL_ASK|go to PostHog|You can skip this one/);
  // the keyboard lights the step back after the first answer and the next card on the last page
  assert.ok(ONBOARDING.includes('pulse(["ctrl", "shift", "up"], LIGHT)'));
  assert.ok(ONBOARDING.includes('pulse(["ctrl", "shift", "right"], LIGHT)'));
  assert.doesNotMatch(ONBOARDING, /#432BFF/i);
  assert.doesNotMatch(ONBOARDING, /—/, "an em dash");
  assert.doesNotMatch(ONBOARDING, /avatar|picture step|\.\.\/facilitator\//i);
  assert.doesNotMatch(ONBOARDING, /var\(--accent|purple|#7c3aed|#8b5cf6/i);
  for (const file of ["/card-markdown.js", "/card-logic.js", "/card-tokens.css"])
    assert.ok(ONBOARDING.includes(file), file + " is not the board's own");
  assert.ok(ONBOARDING.includes('fetch("/onboarding/sample", { method: "POST" })'));
  assert.ok(ONBOARDING.includes('fetch("/profile", { method: "POST", body: JSON.stringify(body) })'));
  assert.ok(ONBOARDING.includes("emailYes: email != null"), "an email given is not the yes");
  assert.ok(ONBOARDING.includes('parent.postMessage({ onboarding: "done", project }, location.origin)'));
  assert.doesNotMatch(ONBOARDING, /placeholder\s*=\s*"[^"]*(\.\.\.|…)"/);
});

test("the cards say what they were given to say, with the board's own marks, on white", () => {
  const context = vm.createContext({});
  vm.runInContext(grab("  const key = name =>", "  // the timings.") + "\nthis.CARDS = CARDS; this.MARK = MARK; this.HI = HI;", context);
  const { CARDS, MARK, HI } = context;
  const say = id => CARDS.find(c => c.id === id).say;
  // the Welcome card: the lockup is the header, then the greeting, the blurb and the key, all to the left
  assert.equal(HI, "Hi there \u{1F44B}");
  assert.ok(ONBOARDING.includes('el.titleEl.innerHTML = \'<span class="obbrand">'), "the lockup is not the header");
  assert.ok(ONBOARDING.includes('\'<div class="obwelcome"><p class="obhi">\' + HI + "</p>" + fmt(WELCOME) + "</div>"'));
  assert.match(ONBOARDING, /\.obwelcome\{display:flex; flex-direction:column; align-items:flex-start; text-align:left\}/);
  assert.doesNotMatch(ONBOARDING, /fitWelcome/);
  // the atomizing card, first of the 101 cards, in the words given, the doubled "acts" gone and the names capitalised
  assert.equal(say("cards"),
    "The only \"rule\" to make the best of the Facilitator is *atomize your asks.*\n\n" +
    "If you are building *n* features or solving *n* bugs or planning a spec with *n* phases, put them on *n* different cards!\n\n" +
    "The Claude or Codex agent connected to a project acts as a manager and assigns those tasks to *n* subagents, " +
    "which parallelizes and speeds up implementation.");
  assert.equal(CARDS[2].id, "cards");
  // 101: Tickets, in the words and lists given, with the section chips' marks
  assert.equal(say("tickets"),
    "Cards are shown as a list of tickets on the left side.\n\n" +
    "Standard tickets have three states:\n- Yellow: Awaiting your input\n- Grey: Queued\n- Green: Actively working\n\n" +
    "Tickets can be put in four buckets:\n" +
    `- ${MARK.sun} Doing: Tasks you are actively working on\n- ${MARK.dock} Docked: Tasks that you will pick up very soon\n` +
    `- ${MARK.moon} Deferred: Tasks for some later coding sprint\n- ${MARK.cross} Done: Tasks that are complete\n\n` +
    "Bonus: after you iterate on a project for a while, tickets/cards act as a sort of knowledge base for a project.");
  // the marks are the top bar's own: the sun and the cloud from card-logic.js, the moon the chip's, the cross its bars
  assert.ok(ONBOARDING.includes("[MARK.sun]: '<span role=\"img\" class=\"obmark\" aria-label=\"sun\">' + SUN_ICON"));
  assert.ok(ONBOARDING.includes("[MARK.dock]: '<span role=\"img\" class=\"obmark\" aria-label=\"sun with cloud\">' + DOCK_ICON"));
  assert.ok(ONBOARDING.includes("[MARK.moon]: '<span role=\"img\" class=\"obmark\" aria-label=\"moon\">' + MOON_ICON"));
  assert.match(ONBOARDING, /\.reply \.obcross::before, \.reply \.obcross::after\{[^}]*width:var\(--bar-mark\); height:var\(--cross-t\); background:#1e1e1e/);
  assert.ok(ONBOARDING.includes("el.reply.innerHTML = withMarks(fmt(raw));"));
  // 101: Hotkeys: the two new lines, a drawn heart, then the sentences and chords it had, Command + T lit first
  const hotkeys = CARDS.find(c => c.id === "hotkeys");
  assert.ok(hotkeys.say.startsWith(`The Facilitator ${MARK.heart} hotkeys!\n\n**Command + T** creates a new card.\n\n` +
                                   "**Control + Shift + ←** and **→** move between cards"), hotkeys.say);
  assert.ok(hotkeys.say.endsWith("**Control + Shift + Backspace** marks a card done."));
  assert.deepEqual(out(hotkeys.lights), [["cmd", "t"], ["ctrl", "shift", "left", "right"], ["ctrl", "shift", "up", "down"],
                                    ["ctrl", "shift", "return"], ["ctrl", "shift", "delete"]]);
  assert.match(ONBOARDING, /const HEART_ICON = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" ' \+\s*'stroke-width="2\.4" stroke-linecap="round" stroke-linejoin="round"/);
  assert.doesNotMatch(say("hotkeys"), /❤|♥|\u{1F496}|\u{1F49C}/u, "the heart is an emoji");
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
  const reading = MAC.slice(MAC.indexOf("async function poll(){"), MAC.indexOf("if (seq <= createSeq) return;"));
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
  for (const id of ["setname", "setemail", "setwork", "setagent", "settz"])
    assert.ok(mac.includes(`id="${id}"`), id);
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
  for (const id of ["pfpic", "pfname", "pfemail", "pfwork", "pfagent", "pftz"]) assert.ok(phone.includes(`id="${id}"`), id);
  assert.doesNotMatch(phone, /<input/, "the phone writes the profile");
  // the phone's Profile is the Mac's: the picture beside the name and email with no label, no feedback switch or
  // status, no note and no subtitles, and the picture and the time zone drawn by the shared code
  assert.doesNotMatch(phone, /pfyes|Feedback emails|sethelp|setnote|avatar/i);
  assert.match(phone, /<div class="setpic" id="pfpic" aria-hidden="true" hidden><\/div>/);
  assert.ok(PHONE.includes("settingsZoneWords(p.timeZone)") && PHONE.includes("SETTINGS_PICTURES[p.picture]"));
  assert.doesNotMatch(mac + phone, /--accent|purple/);
});
