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
                           work: "A research tool for my lab", agent: "Claude Code", time_zone: "America/Phoenix" });
  assert.equal(fs.statSync(path.join(board.app, "profile.json")).mode & 0o777, 0o600);

  // an edit in Settings while the yes holds goes once, alone; the yes taken back sends nothing more
  await board.call("POST", "/profile", JSON.stringify({ work: "Teaching", timeZone: "America/Phoenix" }));
  assert.deepEqual(posthog.bodies[1].body.properties, { $geoip_disable: true, $set: { work: "Teaching" } });
  await board.call("POST", "/profile", JSON.stringify({ emailYes: false }));
  await board.call("POST", "/profile", JSON.stringify({ work: "Writing" }));
  assert.equal(posthog.bodies.length, 2);

  assert.doesNotMatch((await board.call("GET", "/board-settings.js")).text, /BOARD_ONBOARDING/);
  await board.restart();
  assert.doesNotMatch((await board.call("GET", "/board-settings.js")).text, /BOARD_ONBOARDING/);
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

test("the onboarding is the mock's run with the work in the person's own words and the email card's PostHog line", () => {
  for (const title of ["Welcome!", "What should we call you?", "What's your email?",
                       "What will you mostly use Facilitator for?", "Which agent do you use most?", "You're all set!"])
    assert.ok(ONBOARDING.includes(`title: "${title}"`), title);
  assert.match(ONBOARDING, /\{ id: "work", title: "What will you mostly use Facilitator for\?", field: "work", noun: "answer" \}/,
               "the work question offers choices");
  assert.ok(ONBOARDING.includes('const EMAIL_ASK = "Your email, your answers here and your time zone go to PostHog, " +\n' +
                                '                    "so Facilitator\'s maker can ask you for feedback. You can skip this one.";'));
  assert.match(ONBOARDING, /\{ id: "email", [^}]*ask: EMAIL_ASK \}/);
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
  assert.ok(gate.includes('if (!frame.contentDocument?.getElementById("obstage")) away();'),
            "a frame without the onboarding would wall the board off");
  assert.match(MAC, /#onboard\{position:fixed; inset:0;[^}]*z-index:2147483647;[^}]*transition:opacity \.18s ease\}/);
});

test("the Profile section is in Settings on the Mac, editable, and on the phone, shown", () => {
  const mac = MAC.slice(MAC.indexOf('<div data-section="profile" data-label="Profile">'), MAC.indexOf('<div id="appframe"'));
  for (const id of ["setname", "setemail", "setemailyes", "setwork", "setagent", "settz"])
    assert.ok(mac.includes(`id="${id}"`), id);
  assert.match(mac, /<input type="checkbox" role="switch" id="setemailyes">/);
  assert.match(mac, /go to PostHog, so Facilitator's maker can ask you for feedback/);
  assert.ok(MAC.includes('fetch("/profile", { method: "POST", body: JSON.stringify({ ...change, timeZone: hereZone() }) })'));
  const phone = PHONE.slice(PHONE.indexOf('<div data-section="profile" data-label="Profile">'), PHONE.indexOf('<div data-section="diagnostics"'));
  for (const id of ["pfname", "pfemail", "pfyes", "pfwork", "pfagent", "pftz"]) assert.ok(phone.includes(`id="${id}"`), id);
  assert.doesNotMatch(phone, /<input/, "the phone writes the profile");
  assert.doesNotMatch(mac + phone, /--accent|purple/);
});
