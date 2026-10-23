// `facilitator bridge setup`: the installer's banner, its one line under it and
// the two paragraphs saying what Facilitator is, then only the installer's
// "4. Mobile app" step, for someone who said no at install and for someone who
// already set the phone up. Every run is on a throwaway home and copy of the
// checkout with fake commands on PATH (see installer-sandbox.cjs); the output
// is compared with what ./install.sh itself printed in the same sandbox, so
// the two cannot drift apart.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { sandbox } = require("./installer-sandbox.cjs");

const PASSWORD = "Sandbox-pass-2026!";
const PHONE = "Would you like to use the phone client? (y / n) ";
const BOTH = "Is Tailscale installed on both your devices? (y / n) ";
const ANSWER = "answer: ";
const PASSWORDS = [["App password (input hidden): ", PASSWORD + "\n"], ["Confirm app password (input hidden): ", PASSWORD + "\n"]];
const BANNER_LINES = 6; // five rows of letters and the line under them
// what Facilitator is, under the banner: plain, flush left, a blank line
// before each paragraph, broken by hand like every other long line
const ABOUT = [
  "",
  "Facilitator is an opinionated and minimalist interface for",
  "interacting with claude or codex on the terminal.",
  "",
  "Facilitator's UI is designed to help you ship more by atomizing your",
  "builds and orchestrating several subagents.",
];
const HEAD_LINES = BANNER_LINES + ABOUT.length;

async function using(options, body) {
  const f = await sandbox(options);
  // the phone step never reaches Tailscale; a fake one on PATH records any call
  await fs.writeFile(path.join(f.tools, "tailscale"), `#!/bin/sh\necho "tailscale $*" >> "${path.join(f.dir, "calls.log")}"\n`, { mode: 0o755 });
  try { await body(f); } finally { await f.clean(); }
}

const head = text => text.split("\n").slice(0, HEAD_LINES).join("\n");
const about = text => text.split("\n").slice(BANNER_LINES, HEAD_LINES);
// the installer's own "4. Mobile app" step, up to the Chrome graphics step after it
const mobileApp = text => {
  const from = text.indexOf("\n4. Mobile app\n");
  assert.ok(from >= 0, "no Mobile app step:\n" + text);
  const to = text.indexOf("\n5. Chrome graphics\n", from);
  assert.ok(to > from, "no end to the Mobile app step:\n" + text);
  return text.slice(from, to);
};
const nothingElse = text => assert.doesNotMatch(text,
  /Claude Code|Codex|Chrome|3\. Python|uv |Board settings|command and agent skill|Facilitator is installed|Next steps/,
  "a part of the installer other than the phone step ran:\n" + text);

async function assertOnlyPhoneStep(f, before) {
  const calls = (await f.calls()).slice(before);
  assert.deepEqual(calls, [], "the setup looked up or ran something other than the phone step: " + calls.join(" | "));
}

test("said no at install: the banner, its line and what Facilitator is, then the Mobile app step, and nothing else of the installer", async () => {
  await using({}, async f => {
    const install = await f.terminal([[PHONE, "n"]]);
    assert.equal(install.code, 0, install.text);
    const before = (await f.calls()).length;
    const homeBefore = await fs.readdir(f.home, { recursive: true });

    const setup = await f.commandTerminal(["bridge", "setup"], [[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"], ...PASSWORDS]);
    assert.equal(setup.code, 0, setup.text);
    assert.deepEqual(setup.unsent, []);
    assert.ok(setup.text.startsWith(head(install.text) + "\n"), "the banner is not the installer's:\n" + setup.text);
    assert.equal(setup.text.split("\n")[BANNER_LINES - 1].trim(), "installer");
    assert.deepEqual(about(install.text), ABOUT, "the installer does not say what Facilitator is under its banner:\n" + install.text);
    assert.deepEqual(about(setup.text), ABOUT, "the setup does not say what Facilitator is under its banner:\n" + setup.text);
    assert.ok(setup.text.startsWith(head(setup.text) + "\n\n4. Mobile app\n" + "─".repeat(13) + "\n\n"),
      "the Mobile app step does not follow the lines under the banner at once:\n" + setup.text);
    assert.ok(setup.text.includes(`${PHONE}y\n\n4.1 Tailscale\n─────────────\n\n`), setup.text);
    assert.ok(setup.text.includes("4.2 App password\n────────────────\n\nChoose a strong password to log into your Facilitator phone app.\n"), setup.text);
    assert.match(setup.text, /\n✓ App password confirmed\.\n$/);
    assert.ok(!setup.text.includes(PASSWORD), "the password was echoed");
    nothingElse(setup.text.slice(head(setup.text).length));
    assert.equal(await f.has(path.join(f.data, "bridge-auth.json")), true, "the password was not saved");
    await assertOnlyPhoneStep(f, before);
    assert.deepEqual(await fs.readdir(f.home, { recursive: true }), homeBefore, "the home folder changed");
  });
});

test("said no again: the question is asked, the answer is taken, and no password is made", async () => {
  await using({}, async f => {
    assert.equal((await f.terminal([[PHONE, "n"]])).code, 0);
    const before = (await f.calls()).length;
    const setup = await f.commandTerminal(["bridge", "setup"], [[PHONE, "n"]]);
    assert.equal(setup.code, 0, setup.text);
    assert.deepEqual(setup.unsent, []);
    assert.ok(setup.text.endsWith(`\n4. Mobile app\n─────────────\n\nThe phone client puts your board on your phone, over Tailscale and\nbehind an app password.\n\n${PHONE}n\n`), setup.text);
    assert.doesNotMatch(setup.text, /4\.1|4\.2|App password confirmed/);
    assert.equal(await f.has(path.join(f.data, "bridge-auth.json")), false);
    await assertOnlyPhoneStep(f, before);
  });
});

test("already set up: the same step, the same words as the installer's second run, and the password is kept", async () => {
  await using({}, async f => {
    const first = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"], ...PASSWORDS]);
    assert.equal(first.code, 0, first.text);
    const saved = await fs.readFile(path.join(f.data, "bridge-auth.json"), "utf8");
    const second = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"]]);
    assert.equal(second.code, 0, second.text);
    const before = (await f.calls()).length;

    const setup = await f.commandTerminal(["bridge", "setup"], [[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"]]);
    assert.equal(setup.code, 0, setup.text);
    assert.deepEqual(setup.unsent, []);
    assert.equal(setup.text, head(second.text) + "\n" + mobileApp(second.text), "not the installer's banner and step:\n" + setup.text);
    assert.match(setup.text, /4\.2 App password\n────────────────\n\n✓ Existing app password kept\. Use it to sign in on your phone\.\n$/);
    assert.doesNotMatch(setup.text, /App password \(input hidden\)/);
    nothingElse(setup.text.slice(head(setup.text).length));
    assert.equal(await fs.readFile(path.join(f.data, "bridge-auth.json"), "utf8"), saved, "the saved password changed");
    await assertOnlyPhoneStep(f, before);
  });
});

test("the banner is drawn in colour on a terminal exactly as the installer draws it", async () => {
  await using({}, async f => {
    const install = await f.terminal([[PHONE, "n"]], [], { color: true });
    assert.equal(install.code, 0, install.text);
    assert.match(install.text, /\x1b\[38;2;190;55;30m█/);
    const setup = await f.commandTerminal(["bridge", "setup"], [[PHONE, "n"]], { color: true });
    assert.equal(setup.code, 0, setup.text);
    assert.equal(head(setup.text), head(install.text));
    assert.deepEqual(about(setup.text), ABOUT, "the lines under the banner are not plain text");
    assert.match(setup.text, /\n\x1b\[1m4\. Mobile app\x1b\[0m\n/);
  });
});

test("with no terminal it asks nothing and says so in the installer's one line, as the installer does", async () => {
  await using({}, async f => {
    const install = await f.piped();
    assert.equal(install.code, 0, install.text);
    const before = (await f.calls()).length;
    const setup = await f.commandPiped(["bridge", "setup"]);
    assert.equal(setup.code, 0, setup.text);
    assert.equal(setup.text, head(install.text) + "\n" + mobileApp(install.text));
    assert.equal(mobileApp(install.text), "\n4. Mobile app\n─────────────\n\n⊘ Skipped the phone client: there is no interactive terminal.\n");
    assert.doesNotMatch(setup.text, /\x1b|\(y \/ n\)|4\.1|4\.2|Tailscale/);
    assert.equal(await f.has(path.join(f.data, "bridge-auth.json")), false);
    await assertOnlyPhoneStep(f, before);
  });
});

test("Ctrl+C at a question exits with one plain sentence that names this command, not the installer", async () => {
  await using({}, async f => {
    const stopped = await f.commandTerminal(["bridge", "setup"], [[PHONE, "\x03"]]);
    assert.equal(stopped.code, 130, stopped.text);
    assert.match(stopped.text, /\(y \/ n\) (\n?\^C|\^C)?\nExiting facilitator bridge setup\.\n$/, stopped.text.slice(-200));
    assert.doesNotMatch(stopped.text, /Traceback|KeyboardInterrupt|installer\.\n/);
  });
});

test("setup takes no other words, and the bridge help and the command's help both name it", async () => {
  await using({}, async f => {
    for (const extra of [["--dry-run"], ["on"], ["now"]]) {
      const refused = await f.commandPiped(["bridge", "setup", ...extra]);
      assert.equal(refused.code, 1, refused.text);
      assert.equal(refused.text.trim(), `bridge setup takes no other words; got ${extra.join(" ")}`);
    }
    const help = await f.commandPiped(["bridge", "setup", "--help"]);
    assert.equal(help.code, 0, help.text);
    assert.match(help.text, /usage: facilitator bridge \[on\|off\] \[--dry-run\]\n\s+facilitator bridge setup\n/);
    // the full help is what an unknown word prints; a bare --help is run's, which starts the board
    const whole = await f.commandPiped(["help"]);
    assert.equal(whole.code, 1, whole.text);
    assert.match(whole.text, /\n {2}facilitator bridge setup\n {6}set the phone link up after saying no to it at install/);
    assert.match(whole.text, /\n {2}facilitator bridge \[on\|off\] \[--dry-run\]\n/);
    assert.deepEqual(await f.calls(), []);
  });
});

test("install.sh and the command share one source: the step is not written out twice", async () => {
  const root = path.resolve(__dirname, "..");
  const installer = await fs.readFile(path.join(root, "..", "install.sh"), "utf8");
  const shared = await fs.readFile(path.join(root, "installer-lib.sh"), "utf8");
  const command = await fs.readFile(path.join(root, "facilitator"), "utf8");
  assert.match(installer, /^\. "\$REPO\/installer-lib\.sh"$/m);
  assert.match(installer, /^mobile_app$/m);
  assert.match(installer, /^banner\nabout$/m);
  for (const text of ["Would you like to use the phone client?", "'4. Mobile app'", "Tailscale connects your phone", "BANNER_ROWS=",
    "Facilitator is an opinionated"]) {
    assert.ok(shared.includes(text), `${text} is not in the shared file`);
    assert.ok(!installer.includes(text), `${text} is written out again in install.sh`);
    assert.ok(!command.includes(text), `${text} is written out again in the command`);
  }
});
