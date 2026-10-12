// ./install.sh's offer to turn on Chrome's graphics acceleration, against a fake
// Local State in the sandbox home (see installer-sandbox.cjs). On or absent asks
// nothing; off asks once, Enter is no, no terminal changes nothing, and a yes
// waits for Chrome to quit. The fake Chrome holds a SingletonLock to its own pid
// and, as it quits, writes its old Local State back the way Chrome does, so a
// write made while it ran would be lost.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { sandbox } = require("./installer-sandbox.cjs");

const PHONE = "Would you like to use the phone client? (y / n) ";
const QUESTION = "Turn it on? (y / n) ";
const WAITING = "or press n to leave graphics acceleration off.";
const LEFT_OFF = "⊘ Left it off. It is in Chrome under Settings > System.";
const TURNED_ON = "✓ Graphics acceleration turned on. It takes effect when Chrome next opens.";
const OFFER = "5. Chrome graphics\n──────────────────\n\n"
  + "Chrome's graphics acceleration is off. The board runs smoother with it on.\n"
  + "Chrome must be quit to change it.\n\n" + QUESTION;
const COMMAND = "✓ facilitator command and agent skill installed";

async function withChrome(mode, body, options = {}) {
  const f = await sandbox(options);
  const folder = path.join(f.home, "Library", "Application Support", "Google", "Chrome");
  const file = path.join(folder, "Local State");
  await fs.mkdir(folder, { recursive: true });
  const state = { browser: { enabled_labs_experiments: [] }, profile: { info_cache: { Default: { name: "Ünïcode" } } } };
  if (mode !== "absent") state.hardware_acceleration_mode = { enabled: mode === "on" };
  const original = JSON.stringify(state);
  await fs.writeFile(file, original);
  const read = () => fs.readFile(file, "utf8");
  const backup = path.join(folder, "Local State.facilitator-backup");
  try { await body({ f, folder, file, original, read, backup }); } finally {
    await fs.chmod(folder, 0o755).catch(() => {});
    await f.clean();
  }
}

// a stand-in for Chrome on that folder, running until quit() is called
async function fakeChrome(folder, original, dir) {
  const quitFile = path.join(dir, "quit-chrome");
  const seen = path.join(dir, "seen-at-quit");
  const orig = path.join(dir, "chrome-own-copy");
  await fs.writeFile(orig, original);
  const lock = path.join(folder, "SingletonLock");
  const child = spawn("sh", ["-c", `while [ ! -f "${quitFile}" ]; do sleep 0.1; done
cp "${folder}/Local State" "${seen}"
cp "${orig}" "${folder}/Local State"
rm -f "${lock}"`], { stdio: "ignore" });
  await fs.symlink(`Sandbox-Mac.local-${child.pid}`, lock);
  const exited = new Promise(resolve => child.on("exit", resolve));
  return {
    pid: child.pid,
    alive: () => { try { process.kill(child.pid, 0); return true; } catch { return false; } },
    quit: async () => { await fs.writeFile(quitFile, ""); await exited; },
    seenAtQuit: () => fs.readFile(seen, "utf8"),
  };
}

// resolves once the installer's own step is running, so Chrome quits after the
// question was asked
async function stepStarted(repo) {
  for (let i = 0; i < 600; i++) {
    const found = await promisify(execFile)("pgrep", ["-f", `${repo}/facilitator _chrome-acceleration`]).then(() => true, () => false);
    if (found) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("the step never started");
}

test("on, or the key absent, or no Local State: nothing is asked or said, and the file is untouched", async () => {
  for (const mode of ["on", "absent", "missing"]) {
    await withChrome(mode, async ({ f, file, original, read, backup }) => {
      if (mode === "missing") await fs.rm(file);
      const { code, text, unsent } = await f.terminal([[PHONE, "n"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${PHONE}n\n\n${COMMAND}\n`), `${mode}: ${text}`);
      assert.doesNotMatch(text, /Chrome graphics|acceleration/, mode);
      if (mode !== "missing") assert.equal(await read(), original, mode);
      assert.equal(await f.has(backup), false, mode);
    });
  }
});

// the python3 macOS ships (3.9) can run the setup, so the step runs on it too
const APPLE_PYTHON = (() => {
  try {
    return require("node:child_process").execFileSync("/usr/bin/python3", ["-c",
      "import sys; print(sys.version_info[:2] == (3, 9))"], { encoding: "utf8" }).trim() === "True";
  } catch {
    return false;
  }
})();

test("off, yes, Chrome quit: backed up beside it, switched on, everything else kept", async () => {
  for (const python of APPLE_PYTHON ? ["system", "apple"] : ["system"]) {
    await withChrome("off", async ({ f, original, read, backup }) => {
      const { code, text, unsent } = await f.terminal([[PHONE, "n"], [QUESTION, "y"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${PHONE}n\n\n${OFFER}y\n\n${TURNED_ON}\n\n${COMMAND}\n`), `${python}: ${text}`);
      if (python === "apple") assert.ok((await f.calls()).includes(`apple python3 ${f.repo}/facilitator`), python);
      const now = JSON.parse(await read());
      assert.deepEqual(now, { ...JSON.parse(original), hardware_acceleration_mode: { enabled: true } });
      assert.equal(await fs.readFile(backup, "utf8"), original);
      assert.doesNotMatch(text, /\n\n\n/);
    }, { python });
  }
});

test("off, Enter or n: left off in one line, the file untouched, no backup", async () => {
  for (const key of ["\r", "n"]) {
    await withChrome("off", async ({ f, original, read, backup }) => {
      const { code, text, unsent } = await f.terminal([[PHONE, "n"], [QUESTION, `x${key}`]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${OFFER}n\n\n${LEFT_OFF}\n\n${COMMAND}\n`), JSON.stringify(key) + text);
      assert.equal(await read(), original);
      assert.equal(await f.has(backup), false);
    });
  }
});

test("off with no terminal: nothing asked, nothing changed, one line", async () => {
  await withChrome("off", async ({ f, original, read, backup }) => {
    const { code, text } = await f.piped();
    assert.equal(code, 0, text);
    assert.ok(text.includes("5. Chrome graphics\n──────────────────\n\n"
      + "⊘ Left Chrome's graphics acceleration off: there is no interactive terminal.\n\n" + COMMAND), text);
    assert.doesNotMatch(text, /Turn it on/);
    assert.equal(await read(), original);
    assert.equal(await f.has(backup), false);
  });
});

test("off, yes, Chrome running: it waits for Chrome to quit, never quits it, then writes", async () => {
  await withChrome("off", async ({ f, folder, original, read }) => {
    const chrome = await fakeChrome(folder, original, f.dir);
    const run = f.terminal([[PHONE, "n"], [QUESTION, "y"]]);
    await stepStarted(f.repo);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(chrome.alive(), true, "Chrome was quit by the installer");
    await chrome.quit();
    const { code, text } = await run;
    assert.equal(code, 0, text);
    assert.ok(text.includes(`${OFFER}y\n\n`
      + "Chrome is open. Quit it (Command + Q) and setup goes on by itself,\n"
      + `${WAITING}\n\n${TURNED_ON}\n\n${COMMAND}\n`), text);
    assert.equal(JSON.parse(await chrome.seenAtQuit()).hardware_acceleration_mode.enabled, false, "written while Chrome ran");
    assert.equal(JSON.parse(await read()).hardware_acceleration_mode.enabled, true, "lost to Chrome's own write as it quit");
  });
});

test("off, yes, Chrome running, then n: left off, Chrome left running", async () => {
  await withChrome("off", async ({ f, folder, original, read }) => {
    const chrome = await fakeChrome(folder, original, f.dir);
    try {
      const { code, text, unsent } = await f.terminal([[PHONE, "n"], [QUESTION, "y"], [WAITING, "n"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${WAITING}\n\n${LEFT_OFF}\n\n${COMMAND}\n`), text);
      assert.equal(chrome.alive(), true);
      assert.equal(await read(), original);
    } finally { await chrome.quit(); }
  });
});

test("a write that fails leaves Local State as it was and says so in one line", async () => {
  await withChrome("off", async ({ f, folder, original, read, backup }) => {
    await fs.chmod(folder, 0o555);
    const { code, text } = await f.terminal([[PHONE, "n"], [QUESTION, "y"]]);
    assert.equal(code, 0, text);
    assert.match(text, /\n⚠ Could not turn on graphics acceleration \([^\n]*\)\. Chrome's settings were left as they were\.\n\n✓ facilitator command/);
    assert.equal(await read(), original);
    assert.equal(await f.has(backup), false);
  });
});

test("Ctrl+C at the question ends the run in one sentence and changes nothing", async () => {
  await withChrome("off", async ({ f, original, read }) => {
    const { code, text } = await f.terminal([[PHONE, "n"], [QUESTION, "\x03"]]);
    assert.equal(code, 130, text);
    assert.match(text, /Turn it on\? \(y \/ n\) (\n\^C|\^C)?\nExiting facilitator installer\.\n$/);
    assert.doesNotMatch(text, /Traceback|command and agent skill installed/);
    assert.equal(await read(), original);
  });
});
