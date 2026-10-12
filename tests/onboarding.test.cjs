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

// the onboarding's own email check, run in a vm, and the send that uses it, read as source
test("the email is needed: an empty Enter and a malformed email keep the question and ask for one", () => {
  const context = vm.createContext({});
  const grab = (from, to) => ONBOARDING.slice(ONBOARDING.indexOf(from), ONBOARDING.indexOf(to));
  vm.runInContext([
    grab("  function said(text){", "  function plain(text)"),
    grab("  const ADDRESS = ", "  // the last card closed"),
    grab("  const EMAIL_EMPTY = ", "  const QUESTIONS = ["),
  ].join("\n"), context);
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

  // the send: an empty or malformed email never reaches answer(), and neither
  // does an empty name; an empty work answer still skips
  const send = ONBOARDING.slice(ONBOARDING.indexOf("  function sendFrom(card){"), ONBOARDING.indexOf("  // the answer comes the moment the send's flight"));
  const order = [...send.matchAll(/q\.check\(text\)|return false|q\.needed|answer\(card, \[\], page\.field\)/g)].map(m => m[0]);
  assert.deepEqual(order, ["return false", "return false", "q.check(text)", "return false", "q.needed", "return false", "answer(card, [], page.field)"]);
  assert.match(send, /const problem = q\.check \? q\.check\(text\) : "";\s*if \(problem\)\{\s*card\.asking = problem;\s*render\(el, pageRaw\(card, pageOnShow\(card\)\)\);\s*printReply\(el\);\s*return false;/);
  assert.ok(ONBOARDING.includes("card.asking = null;"), "an answer leaves the ask on the page");
  // the line shows under the email question only, and no Enter-to-skip line stands under a needed one
  assert.ok(ONBOARDING.includes('parts.push(q.ask, q.note, q.check && card.asking, q.needed ? "" : SKIP_HINT);'));
});

test("the onboarding is Welcome, one onboarding card of four questions with a needed email, and four 101 cards", () => {
  for (const title of ["Welcome!", "Let's onboard you onto the Facilitator!", "101: Orchestrator Agent",
                       "101: Cards & atomizing ideas", "101: Tickets", "101: Hotkeys"])
    assert.ok(ONBOARDING.includes(`title: "${title}"`), title);
  // the questions are the onboarding card's replies, each tied to the field it fills
  for (const [field, ask] of [["name", "What should we call you?"], ["email", "What's your email?"],
                              ["work", "What will you mostly use Facilitator for?"], ["agent", "Which agent do you use most?"]])
    assert.ok(ONBOARDING.includes(`{ field: "${field}", ask: "${ask}"`), field);
  assert.match(ONBOARDING, /\{ field: "work", ask: "What will you mostly use Facilitator for\?", noun: "answer" \}/,
               "the work question offers choices");
  assert.match(ONBOARDING, /\{ field: "name", [^}]*needed: true \}/, "the name is not the one answer needed");
  // the email is needed like the name; the PostHog line and the skip are gone
  assert.match(ONBOARDING, /\{ field: "email", [^}]*needed: true, check: emailProblem \}/, "the email is not needed");
  assert.doesNotMatch(ONBOARDING, /EMAIL_ASK|go to PostHog|You can skip this one/);
  assert.match(ONBOARDING, /\{ field: "work", [^}]*\}/);
  assert.doesNotMatch(ONBOARDING.match(/\{ field: "(work|agent)", [^}]*\}/g).join(""), /needed/, "another question is needed");
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
