// ./install.sh from the first check to the closing message: Claude Code or
// Codex, Chrome, a private Python through uv, the optional phone client
// (Tailscale, then the app password), the command and skill, then the end.
// Each run is on a throwaway home and copy of the checkout with fake commands
// on PATH (see installer-sandbox.cjs), and the questions are answered through a
// pseudo terminal, so nothing real is looked up, installed or downloaded.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { sandbox, root } = require("./installer-sandbox.cjs");

const URLS = {
  claude: "https://code.claude.com/docs/en/overview",
  codex: "https://developers.openai.com/codex/cli",
  chrome: "https://www.google.com/chrome/",
  tailscale: "https://tailscale.com/download",
};
const MDFIND = "mdfind kMDItemCFBundleIdentifier == 'com.google.Chrome'";
const PASSWORD = "Sandbox-pass-2026!";
const PHONE = "Would you like to use the phone client? (y / n) ";
const BOTH = "Is Tailscale installed on both your devices? (y / n) ";
const ANSWER = "answer: ";
const PASSWORDS = [["App password (input hidden): ", PASSWORD + "\n"], ["Confirm app password (input hidden): ", PASSWORD + "\n"]];
const CLOSING = "✦ Facilitator is installed!\n\nNext steps:\n\n1. Start the board: facilitator run\n"
  + "2. Complete the quick onboarding to start using the Facilitator!";

async function using(options, body) {
  const f = await sandbox(options);
  try { await body(f); } finally { await f.clean(); }
}

const NOTHING_MADE = ["repo/.venv", "repo/run.config.json", "repo/seed.json", "home/.local", "home/.claude", "home/.agents", "home/.zshrc"];
async function assertNothingChanged(f) {
  for (const name of NOTHING_MADE) assert.equal(await f.has(path.join(f.dir, name)), false, `${name} was made`);
  assert.deepEqual(await fs.readdir(f.home), [], "the home folder was touched");
}

function assertSections(text, titles) {
  const lines = text.split("\n");
  let last = -1;
  for (const title of titles) {
    const at = lines.indexOf(title);
    assert.ok(at > last, `${title} is missing or out of order`);
    assert.equal(lines[at - 1], "", `no blank line before ${title}`);
    assert.equal(lines[at + 1], "─".repeat([...title].length), `the rule under ${title}`);
    assert.equal(lines[at + 2], "", `no blank line after the rule under ${title}`);
    last = at;
  }
  assert.doesNotMatch(text, /\n\n\n/, "two blank lines in a row");
}

test("with neither Claude Code nor Codex it prints both links, stops, and changes nothing", async () => {
  await using({ agents: [] }, async f => {
    const { code, text } = await f.terminal([]);
    assert.equal(code, 1, text);
    assert.ok(text.includes("1. Claude Code or Codex\n───────────────────────\n\n"
      + "⚠ Neither Claude Code nor Codex was found.\n\n"
      + "Facilitator needs at least one of them. Install one:\n"
      + `Claude Code: ${URLS.claude}\n`
      + `Codex: ${URLS.codex}\n\n`
      + "Then run ./install.sh again. Nothing was changed.\n"), text);
    assert.doesNotMatch(text, /2\. Chrome/);
    assert.deepEqual(await f.calls(), [], "nothing was looked up or run");
    await assertNothingChanged(f);
  });
});

test("one of the two is enough, and each one found is named", async () => {
  for (const [agents, found, absent] of [[["claude"], "Claude Code", "Codex"], [["codex"], "Codex", "Claude Code"],
    [["claude", "codex"], "Claude Code found.\n✓ Codex", ""]]) {
    await using({ agents }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 0, text);
      assert.ok(text.includes(`✓ ${found} found.`), `${agents}: ${text}`);
      if (absent) assert.doesNotMatch(text, new RegExp(`${absent} found`), agents.join());
      assert.match(text, /\n2\. Chrome\n/);
    });
  }
});

test("without Chrome it prints the download link, says the board is its own app window, and changes nothing", async () => {
  await using({ chrome: "none" }, async f => {
    const { code, text } = await f.terminal([]);
    assert.equal(code, 1, text);
    assert.ok(text.includes("✓ Claude Code found.\n\n2. Chrome\n─────────\n\n"
      + "⚠ Chrome was not found.\n\n"
      + "Facilitator is meant to run as its own Chrome app window, not in a\n"
      + "browser tab. Install Chrome:\n"
      + `${URLS.chrome}\n\n`
      + "Then run ./install.sh again. Nothing was changed.\n"), text);
    assert.doesNotMatch(text, /3\. Python/);
    assert.deepEqual(await f.calls(), [MDFIND, "open -Ra Google Chrome"]);
    await assertNothingChanged(f);
  });
});

test("Chrome is asked of macOS and never found by reading the Applications folder", async () => {
  await using({ chrome: "spotlight" }, async f => {
    const { code, text } = await f.piped();
    assert.equal(code, 0, text);
    assert.match(text, /\n✓ Chrome found\.\n/);
    assert.deepEqual((await f.calls()).filter(line => /^(mdfind|open)/.test(line)), [MDFIND], "Spotlight alone was enough");
  });
  await using({ chrome: "launchservices" }, async f => {
    const { code, text } = await f.piped();
    assert.equal(code, 0, text);
    assert.match(text, /\n✓ Chrome found\.\n/);
    assert.deepEqual((await f.calls()).filter(line => /^(mdfind|open)/.test(line)), [MDFIND, "open -Ra Google Chrome"]);
  });
  const code = (await fs.readFile(path.join(root, "install.sh"), "utf8")).split("\n").filter(line => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /Applications|\.app\b|^\s*(ls|find)\s/m, "the installer must not look into the Applications folder");
});

test("a full run with no phone client makes the private environment and the command, and asks nothing else", async () => {
  await using({ agents: ["claude", "codex"] }, async f => {
    const { code, text, unsent } = await f.terminal([[PHONE, "n"]]);
    assert.equal(code, 0, text);
    assert.deepEqual(unsent, []);
    assertSections(text, ["1. Claude Code or Codex", "2. Chrome", "3. Python", "4. Mobile app"]);
    assert.ok(text.includes("✓ Claude Code found.\n✓ Codex found.\n"), text);
    assert.ok(text.includes("✓ Chrome found.\n"), text);
    assert.ok(text.includes("3. Python\n─────────\n\n"
      + "Setup installs what Facilitator needs when it is missing.\n\n"
      + "✓ uv found.\n"), text);
    assert.doesNotMatch(text, /runs this setup|only the tests need|--dev/, "a line about the setup's Python or about --dev was printed:\n" + text);
    assert.ok(text.includes("Setting up the Python 3.14 environment.\n✓ Python 3.14 environment ready.\n"
      + "Installing the packages Facilitator needs.\n✓ Packages installed.\n"
      + "✓ Board settings created.\n✓ Starting board created.\n\n4. Mobile app\n"), text);
    assert.doesNotMatch(text, /fake uv|Board installed|Config lives beside|Environment created|Packages synced|Wrote run\.config/,
      "uv's own lines, a file name or a technical line was printed:\n" + text);
    assert.ok(text.includes("4. Mobile app\n─────────────\n\n"
      + "The phone client puts your board on your phone, over Tailscale and\n"
      + "behind an app password.\n\n"
      + `${PHONE}n\n\n✓ facilitator command and agent skill installed\nOpen a new terminal to use facilitator.\n\n`
      + `${CLOSING}\n\n`), text);
    assert.doesNotMatch(text, /Tailscale\n─|4\.1|4\.2|App password|Claude limits|settings\.json/);
    assert.equal(await f.has(path.join(f.repo, ".venv", "bin", "python")), true);
    for (const name of ["run.config.json", "seed.json"]) assert.equal(await f.has(path.join(f.repo, name)), true, name);
    assert.equal(await fs.readlink(path.join(f.home, ".local/share/facilitator/bin/facilitator")), path.join(f.repo, "facilitator"));
    for (const host of [".claude", ".agents"])
      assert.equal(await fs.readlink(path.join(f.home, host, "skills", "facilitator")), path.join(f.repo, ".agents/skills/facilitator"));
    assert.equal(await f.has(path.join(f.home, ".claude", "settings.json")), false, "no status line entry is added any more");
    const calls = await f.calls();
    const at = line => calls.indexOf(line);
    assert.ok(at("uv python install --no-bin 3.14") >= 0, calls.join(" | "));
    assert.ok(at("uv python install --no-bin 3.14") < at("uv venv --clear --managed-python --python 3.14 .venv"),
      "the app's Python 3.14 comes from uv even with a good python3 here: " + calls.join(" | "));
    assert.ok(!calls.some(line => line.startsWith("uv python find")), "a good python3 runs the setup, so none is fetched for it");
    assert.equal(await fs.readFile(path.join(f.repo, ".venv", "pyvenv.cfg"), "utf8"), "home = /fake\nversion_info = 3.14.0\n");
  });
});

test("phone client yes, Tailscale on both, HTTPS on: the question texts and the app password", async () => {
  await using({}, async f => {
    const { code, text, unsent } = await f.terminal([[PHONE, "Y"], [BOTH, "y"], [ANSWER, "y"], ...PASSWORDS]);
    assert.equal(code, 0, text);
    assert.deepEqual(unsent, []);
    assertSections(text, ["4. Mobile app", "4.1 Tailscale", "4.2 App password"]);
    assert.ok(text.includes(`${PHONE}y\n\n4.1 Tailscale\n─────────────\n\n`
      + "Tailscale connects your phone to the board on your Mac privately,\n"
      + "without opening it to the internet. It is free.\n\n"
      + `${BOTH}y\n\n`
      + "Are HTTPS certificates switched on for your Tailscale account?\n\n"
      + "  y - yes!\n  n - no / I do not know\n\n"
      + `${ANSWER}y\n\n4.2 App password\n────────────────\n\n`
      + "Choose a strong password to log into your Facilitator phone app.\n"
      + "Use at least 11 characters, with a letter, a number and a symbol.\n\n"), text);
    assert.match(text, /\n✓ App password confirmed\.\n\n✓ facilitator command and agent skill installed\n/);
    assert.doesNotMatch(text, /Once installed|Turning on HTTPS|Would you like to install it now/);
    assert.ok(!text.includes(PASSWORD), "the password was echoed");
    assert.ok(text.endsWith(`${CLOSING}\n\n`) || text.endsWith(`${CLOSING}\n`), text.slice(-200));
  });
});

test("Tailscale not installed, install now: the link, the App Store, a key, then HTTPS off and how to switch it on", async () => {
  await using({}, async f => {
    const steps = [[PHONE, "xq \ny"], [BOTH, "n"], [ANSWER, "y"], ["Once installed, press any key.", "x"], [ANSWER, "n"], ...PASSWORDS];
    const { code, text, unsent } = await f.terminal(steps);
    assert.equal(code, 0, text);
    assert.deepEqual(unsent, []);
    assert.ok(text.includes(`${PHONE}y\n`), "keys that are not answers were not ignored");
    assert.ok(text.includes(`${BOTH}n\n\n`
      + "Would you like to install it now or later?\n\n"
      + "  y - yes, I would like to install it now\n"
      + "  n - no, I will install it later\n\n"
      + `${ANSWER}y\n\n`
      + `Get Tailscale for your Mac and your phone: ${URLS.tailscale}\n`
      + "On your phone, the App Store is the easiest place to get it.\n\n"
      + "Once installed, press any key.\n\n"
      + "Are HTTPS certificates switched on for your Tailscale account?\n\n"
      + "  y - yes!\n  n - no / I do not know\n\n"
      + `${ANSWER}n\n\n`
      + "Turning on HTTPS certificates is a one time step and quite simple:\n\n"
      + "Tailscale -> Network -> DNS -> Enable MagicDNS and allow HTTPS Certificates\n\n"
      + "4.2 App password\n"), text);
    assert.doesNotMatch(text, /\n\n\n/, "two blank lines in a row");
  });
});

test("Tailscale not installed, install later: a reminder, no HTTPS question, then the app password", async () => {
  await using({}, async f => {
    const { code, text, unsent } = await f.terminal([[PHONE, "y"], [BOTH, "n"], [ANSWER, "n"], ...PASSWORDS]);
    assert.equal(code, 0, text);
    assert.deepEqual(unsent, []);
    assert.ok(text.includes(`${ANSWER}n\n\n`
      + "The phone client needs Tailscale on your Mac and your phone, with\n"
      + "HTTPS certificates switched on for your Tailscale account.\n\n"
      + "4.2 App password\n"), text);
    assert.doesNotMatch(text, /Are HTTPS certificates|Get Tailscale|Once installed|Turning on HTTPS/);
    assert.match(text, /✓ App password confirmed\./);
  });
});

test("a run with no terminal asks nothing, treats the phone client as no, and says so in one line", async () => {
  await using({}, async f => {
    const { code, text } = await f.piped();
    assert.equal(code, 0, text);
    assertSections(text, ["1. Claude Code or Codex", "2. Chrome", "3. Python", "4. Mobile app"]);
    assert.ok(text.includes("4. Mobile app\n─────────────\n\n⊘ Skipped the phone client: there is no interactive terminal.\n\n"
      + "✓ facilitator command and agent skill installed\n"), text);
    assert.doesNotMatch(text, /\(y \/ n\)|4\.1|4\.2|App password|Tailscale/);
    assert.ok(text.endsWith(`${CLOSING}\n\n`), text.slice(-200));
  });
});

test("stopping at a question leaves the command alone, and running again finishes safely", async () => {
  await using({}, async f => {
    const stopped = await f.terminal([[PHONE, "\x03"]]);
    assert.equal(stopped.code, 130, stopped.text);
    assert.doesNotMatch(stopped.text, /command and agent skill installed|Facilitator is installed/);
    assert.equal(await f.has(path.join(f.home, ".local")), false, "the command was linked before the question was answered");
    const again = await f.terminal([[PHONE, "n"]]);
    assert.equal(again.code, 0, again.text);
    assert.match(again.text, /✓ Environment found in \.venv \(Python 3\.14\)\./);
    assert.ok(again.text.includes(CLOSING), again.text);
  });
});

// Ctrl+C in a step the command runs ends with one plain sentence on its own
// line, never a Python traceback, and the run stops with the interrupted status
const EXITING = "Exiting facilitator installer.";
function assertPlainExit(stopped, after) {
  assert.equal(stopped.code, 130, stopped.text);
  assert.ok(stopped.text.includes(`${after}\n${EXITING}\n`), stopped.text.slice(-300));
  assert.doesNotMatch(stopped.text, /Traceback|KeyboardInterrupt|File "|\.py"/, "a traceback was printed:\n" + stopped.text);
  assert.doesNotMatch(stopped.text, /command and agent skill installed|Facilitator is installed/);
}

test("Ctrl+C at the first app password prompt exits with one plain sentence and no traceback", async () => {
  await using({}, async f => {
    const stopped = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"], [PASSWORDS[0][0], "\x03"]]);
    assertPlainExit(stopped, PASSWORDS[0][0]);
    assert.equal(await f.has(path.join(f.home, ".local")), false, "the command was linked");
    assert.equal(await f.has(path.join(f.repo, "bridge-auth.json")), false, "a password was saved");
  });
});

test("Ctrl+C at the confirm prompt exits the same way, and no password is saved", async () => {
  await using({}, async f => {
    const stopped = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"], PASSWORDS[0], [PASSWORDS[1][0], "\x03"]]);
    assertPlainExit(stopped, PASSWORDS[1][0]);
    assert.ok(!stopped.text.includes(PASSWORD), "the password was echoed");
    assert.equal(await f.has(path.join(f.repo, "bridge-auth.json")), false, "a password was saved");
  });
});

test("Ctrl+C in the middle of the package sync exits the same way and shows nothing the sync had printed", async () => {
  await using({ hang: "sync" }, async f => {
    const stopped = await f.terminal([["Installing the packages Facilitator needs.", "\x03"]]);
    assert.equal(stopped.code, 130, stopped.text);
    assert.ok(stopped.text.includes(`Installing the packages Facilitator needs.\n^C\n${EXITING}\n`), stopped.text.slice(-300));
    assert.doesNotMatch(stopped.text, /Traceback|KeyboardInterrupt|File "|syncing \(fake uv\)|✓ Packages installed/);
    assert.equal(await f.has(path.join(f.home, ".local")), false, "the command was linked");
  });
});

test("a second run on an installed copy keeps the password and the config and makes nothing again", async () => {
  await using({ agents: ["claude", "codex"] }, async f => {
    const first = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"], ...PASSWORDS]);
    assert.equal(first.code, 0, first.text);
    const edited = '{"my": "edit"}\n';
    await fs.writeFile(path.join(f.repo, "run.config.json"), edited);
    const before = (await f.calls()).length;
    const second = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"]]);
    assert.equal(second.code, 0, second.text);
    assert.deepEqual(second.unsent, []);
    assert.match(second.text, /✓ Environment found in \.venv \(Python 3\.14\)\.\n/);
    assert.match(second.text, /✓ run\.config\.json found\.\n✓ seed\.json found\./);
    assert.match(second.text, /4\.2 App password\n────────────────\n\n✓ Existing app password kept\. Use it to sign in on your phone\.\n\n/);
    assert.doesNotMatch(second.text, /App password \(input hidden\)|Open a new terminal/);
    assert.match(second.text, /\n✓ facilitator command and agent skill installed\n\n✦ Facilitator is installed!/);
    assert.equal(await fs.readFile(path.join(f.repo, "run.config.json"), "utf8"), edited, "the config was rewritten");
    assert.ok(!(await f.calls()).slice(before).some(line => line.startsWith("uv venv")), "the environment was made again");
    assert.equal((await fs.readFile(path.join(f.home, ".zshrc"), "utf8").catch(() => "")).split("# >>> Facilitator installer >>>").length - 1, 1);
  });
});

test("with no Python it can use, uv is fetched and then a Python, and the environment is still private", async () => {
  for (const python of ["missing", "old"]) {
    await using({ python, uv: "brew" }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 0, `${python}: ${text}`);
      assert.ok(text.includes("3. Python\n─────────\n\n"
        + "Setup installs what Facilitator needs when it is missing.\n\n"
        + "No Python this setup can use was found (it needs 3.9 or newer).\n"
        + "uv will provide one for the private environment.\n"
        + "uv is not installed. Installing it with Homebrew.\n"), `${python}: ${text}`);
      assert.match(text, /\n✓ uv installed\.\nInstalling Python 3\.14 with uv\.\n/);
      assert.match(text, /\n✓ Python 3\.14 installed\.\n/);
      const calls = (await f.calls()).filter(line => !line.startsWith("python3"));
      const at = name => calls.findIndex(line => line.startsWith(name));
      assert.ok(at("brew install uv") >= 0, calls.join(" | "));
      assert.ok(at("brew install uv") < at("uv python install --no-bin 3.14"), calls.join(" | "));
      assert.ok(at("uv python install --no-bin 3.14") < at("uv python find --managed-python 3.14"), calls.join(" | "));
      assert.ok(at("uv python find --managed-python 3.14") < at("uv venv --clear --managed-python --python 3.14 .venv"), calls.join(" | "));
      assert.equal(await f.has(path.join(f.repo, ".venv", "bin", "python")), true);
    });
  }
});

// the python3 macOS ships: 3.9, without the scrypt the app password is hashed with
const APPLE_PYTHON = (() => {
  try {
    return require("node:child_process").execFileSync("/usr/bin/python3", ["-c",
      "import hashlib, sys; print(sys.version_info[:2] == (3, 9) and not hasattr(hashlib, 'scrypt'))"],
      { encoding: "utf8" }).trim() === "True";
  } catch {
    return false;
  }
})();

test("the python3 macOS ships runs the setup, and the app password is set on .venv's Python", { skip: !APPLE_PYTHON && "no /usr/bin/python3 3.9 without scrypt here" }, async () => {
  await using({ python: "apple" }, async f => {
    const { code, text, unsent } = await f.terminal([[PHONE, "y"], [BOTH, "y"], [ANSWER, "y"], ...PASSWORDS]);
    assert.equal(code, 0, text);
    assert.deepEqual(unsent, []);
    assert.doesNotMatch(text, /runs this setup/, "the version of the Python that runs the setup was printed");
    assert.doesNotMatch(text, /No Python this setup can use/);
    assert.ok((await f.calls()).some(line => line.startsWith("apple python3")), "the Apple python3 did not run the setup");
    assert.match(text, /\n✓ App password confirmed\.\n/);
    assert.ok(!text.includes(PASSWORD), "the password was echoed");
    const auth = JSON.parse(await fs.readFile(path.join(f.repo, "bridge-auth.json"), "utf8"));
    assert.match(auth.password, /^[0-9a-f]{128}$/, "no scrypt hash was written");
    const calls = await f.calls();
    assert.ok(calls.includes("apple python3 " + path.join(f.repo, "facilitator")), "Apple's python3 did not run the setup");
    assert.ok(!calls.some(line => line.startsWith("uv python find")), "a Python was fetched for the setup anyway");
  });
});

const PROBE_SHA256 = require("node:crypto").createHash("sha256").update("x").digest("hex");

// both ways uv gets installed: by install.sh when no python3 can run the
// setup, and by the command when one can
for (const python of ["missing", "system"]) {
  test(`with no uv and no Homebrew, uv's own installer runs, told to leave the shell profile alone (${python} python3)`, async () => {
    await using({ python, uv: "curl" }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 0, text);
      assert.match(text, /uv is not installed\. Installing it with the astral\.sh installer\ninto your home\.\n✓ uv installed\./);
      assert.doesNotMatch(text, /downloading uv|installing to/, "the uv installer's own progress lines were printed:\n" + text);
      const calls = await f.calls();
      assert.ok(calls.some(line => /^curl --proto =https --tlsv1\.2 -LsSf https:\/\/astral\.sh\/uv\/0\.12\.22\/install\.sh/.test(line)), calls.join(" | "));
      assert.ok(!calls.some(line => /astral\.sh\/uv\/install\.sh/.test(line)), "the unpinned address was fetched");
      assert.ok(calls.includes("uv installer ran with INSTALLER_NO_MODIFY_PATH=1"), calls.join(" | "));
      assert.equal(await f.has(path.join(f.repo, ".venv", "bin", "python")), true);
    });
  });

  test(`a uv installer that fails shows what it printed, then stops (${python} python3)`, async () => {
    await using({ python, uv: "curl-fails" }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 1, text);
      assert.match(text, /installing to .*\.local\/bin\nthe fake uv installer could not write uv\n\n⚠ The uv installer did not finish\.\n  Install uv yourself, then run \.\/install\.sh again\./);
      assert.doesNotMatch(text, /✓ uv installed/);
      assert.equal(await f.has(path.join(f.repo, ".venv")), false);
    });
  });

  test(`the uv installer is given a working sha256sum to check its own downloads with (${python} python3)`, async () => {
    await using({ python, uv: "curl" }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 0, text);
      const calls = await f.calls();
      assert.ok(calls.includes(`uv installer checks with ${PROBE_SHA256}`), calls.join(" | "));
    });
  });

  test(`a uv installer that is not the expected one is refused and never run (${python} python3)`, async () => {
    await using({ python, uv: "curl-tampered" }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 1, text);
      assert.match(text, /⚠ The uv installer from astral\.sh is not the one this checkout expects\.\n  Nothing was run\./);
      const calls = await f.calls();
      assert.ok(!calls.includes("a changed uv installer ran"), "the changed installer ran");
      assert.equal(await f.has(path.join(f.home, ".local", "bin", "uv")), false);
      assert.equal(await f.has(path.join(f.repo, ".venv")), false);
    });
  });
}

test("a uv older than 0.9.0 cannot install Python 3.14, so the run stops in one line before .venv is made", async () => {
  const LINE = "⚠ uv 0.8.19 is too old to install Python 3.14: upgrade it to 0.9.0 or newer "
    + "(brew upgrade uv, or uv self update), then run ./install.sh again.\n";
  // the command's own check, and the installer's when it needs uv for a Python first
  for (const python of ["system", "missing"]) {
    await using({ python, uvVersion: "0.8.19" }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 1, `${python}: ${text}`);
      assert.ok(text.includes(LINE), `${python}: ${text}`);
      const calls = await f.calls();
      assert.ok(calls.includes("uv --version"), calls.join(" | "));
      assert.ok(!calls.some(line => /^uv (python|venv|pip)/.test(line)), `${python}: uv was used anyway: ${calls.join(" | ")}`);
      assert.equal(await f.has(path.join(f.repo, ".venv")), false);
    });
  }
  // the versions are compared as numbers: 0.10 is newer than 0.9
  for (const uvVersion of ["0.9.0", "0.10.2"]) {
    await using({ python: "missing", uvVersion }, async f => {
      const { code, text } = await f.piped();
      assert.equal(code, 0, `${uvVersion}: ${text}`);
      assert.doesNotMatch(text, /too old/);
    });
  }
});

test("a command or skill name that is already taken stops the run before the environment is made", async () => {
  await using({}, async f => {
    const link = path.join(f.home, ".claude/skills/facilitator");
    await fs.mkdir(link, { recursive: true });
    await fs.writeFile(path.join(link, "mine.txt"), "mine");
    const { code, text } = await f.piped();
    assert.equal(code, 1, text);
    assert.match(text, /already exists/);
    assert.equal(await f.has(path.join(f.repo, ".venv")), false);
    assert.equal(await fs.readFile(path.join(link, "mine.txt"), "utf8"), "mine");
  });
});

test("a file already on the facilitator command's name stops the run in plain lines, before anything is made", async () => {
  await using({}, async f => {
    const bin = path.join(f.home, ".local/share/facilitator/bin/facilitator");
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, "something else\n");
    const { code, text } = await f.piped();
    assert.equal(code, 1, text);
    assert.ok(text.includes("✓ Chrome found.\n\n"
      + `⚠ The facilitator command could not be set up: a file already exists at ${bin}.\n\n`
      + "Move or remove that file, then run ./install.sh again. Nothing was changed.\n"), text);
    assert.doesNotMatch(text, /Leaving it untouched|\n {2}\S/, "an indented line was printed");
    assert.equal(await f.has(path.join(f.repo, ".venv")), false);
    assert.equal(await fs.readFile(bin, "utf8"), "something else\n");
  });
});

test("the help text describes the new flow, and the script has no Claude limits step and no em dash", async () => {
  await using({}, async f => {
    const { code, text } = await f.terminal([], ["--help"]);
    assert.equal(code, 0, text);
    assert.ok(text.includes("usage: ./install.sh [--dev]\n\nCheck for Claude Code or Codex and Chrome, set up a private Python\n"), text);
    assert.match(text, /phone client \(Tailscale and\nan app password\)/);
    assert.match(text, /--dev also installs the packages only the tests need/);
    assert.doesNotMatch(text, /limits/i);
    assert.deepEqual(await f.calls(), []);
    await assertNothingChanged(f);
  });
  const source = await fs.readFile(path.join(root, "install.sh"), "utf8");
  assert.ok(!source.includes(String.fromCharCode(8212)), "an em dash");
  assert.doesNotMatch(source, /Claude limits|claude-statusline|statusline/i);
  for (const url of Object.values(URLS)) assert.ok(source.includes(url), url);
});

test("a normal run leaves the test packages out, even with node and npm here", async () => {
  await using({ node: true }, async f => {
    const { code, text } = await f.piped();
    assert.equal(code, 0, text);
    const calls = await f.calls();
    assert.ok(!calls.some(line => line.startsWith("npm")), "npm ran: " + calls.join(" | "));
    assert.equal(await f.has(path.join(f.repo, "tests", "node_modules")), false);
    assert.equal(await f.has(path.join(f.repo, "node_modules")), false);
    assert.equal(await f.has(path.join(f.repo, "package.json")), false);
    assert.doesNotMatch(text, /npm|puppeteer|Test packages/);
  });
});

test("--dev adds the test packages from the lockfile in tests/, after the board's own", async () => {
  await using({ node: true }, async f => {
    const { code, text } = await f.piped(["--dev"]);
    assert.equal(code, 0, text);
    assert.match(text, /✓ Packages installed\.\n[^]*Installing the packages the tests need\.\n✓ Packages for the tests installed\.\n/);
    assert.doesNotMatch(text, /npm notice|added \d+ packages|package-lock/, "npm's own lines were printed");
    const calls = await f.calls();
    assert.ok(calls.includes("npm ci --ignore-scripts --no-audit --no-fund"), calls.join(" | "));
    assert.ok(calls.includes(`npm ran in ${path.join(f.repo, "tests")}`), calls.join(" | "));
    assert.equal(calls.filter(line => line.startsWith("npm ") && !line.startsWith("npm ran")).length, 1, calls.join(" | "));
    assert.equal(await f.has(path.join(f.repo, "tests", "node_modules", "puppeteer-core", "package.json")), true);
    assert.equal(await f.has(path.join(f.repo, "node_modules")), false, "the packages went into the checkout's root");
    assert.equal(await f.has(path.join(f.repo, "package.json")), false);
    assert.ok(text.includes(CLOSING), text);
  });
});

test("--dev without node stops with the reason before the environment is made", async () => {
  await using({}, async f => {
    const { code, text } = await f.piped(["--dev"]);
    assert.equal(code, 1, text);
    assert.ok(text.includes("⚠ --dev needs node and npm, and they were not found.\n  Install Node.js, then run ./install.sh --dev again.\n"), text);
    assert.equal(await f.has(path.join(f.repo, ".venv")), false);
    assert.equal(await f.has(path.join(f.repo, "tests", "node_modules")), false);
    assert.ok(!text.includes("Facilitator is installed"), text);
  });
});
