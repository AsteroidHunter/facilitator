// ./install.sh's Chrome graphics acceleration step, against a fake Local State in
// the sandbox home (see installer-sandbox.cjs). On (the key true or absent) it
// prints one check line. Off with Chrome closed it asks to turn it on, y or n.
// Off with Chrome open it prints where to turn it on and asks y or l, and never
// quits or waits for Chrome. No terminal asks nothing and changes nothing. The
// fake Chrome holds a SingletonLock to its own pid, as Chrome does.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { sandbox } = require("./installer-sandbox.cjs");

const PHONE = "Would you like to use the phone client? (y / n) ";
const ASK = "Turn on Chrome graphics acceleration?\n\n  y - yes (recommended)\n  n - no\n\nanswer: ";
const STEPS = "Turn on graphics acceleration in Chrome:\n\n"
  + 'Settings -> System -> turn on "Use graphics acceleration when available"\n\n'
  + "  y - I turned gpu acceleration on\n  l - I will do it later\n\nanswer: ";
const SECTION = "5. Chrome graphics\n──────────────────\n\n";
const IS_ON = "✓ Chrome graphics acceleration is on.";
const REOPEN = "Quit and reopen Chrome for graphics acceleration to take place.";
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
async function fakeChrome(folder) {
  const quitFile = path.join(folder, "..", "quit-chrome");
  const lock = path.join(folder, "SingletonLock");
  const child = spawn("sh", ["-c", `while [ ! -f "${quitFile}" ]; do sleep 0.1; done`], { stdio: "ignore" });
  await fs.symlink(`Sandbox-Mac.local-${child.pid}`, lock);
  const exited = new Promise(resolve => child.on("exit", resolve));
  return {
    alive: () => { try { process.kill(child.pid, 0); return true; } catch { return false; } },
    quit: async () => { await fs.writeFile(quitFile, ""); await exited; },
  };
}

// the python3 macOS ships (3.9) can run the setup, so the step runs on it too
const APPLE_PYTHON = (() => {
  try {
    return require("node:child_process").execFileSync("/usr/bin/python3", ["-c",
      "import sys; print(sys.version_info[:2] == (3, 9))"], { encoding: "utf8" }).trim() === "True";
  } catch {
    return false;
  }
})();

test("on, the key absent, or no Local State yet: one check line, no question, the file untouched", async () => {
  for (const mode of ["on", "absent", "missing"]) {
    await withChrome(mode, async ({ f, file, original, read, backup }) => {
      if (mode === "missing") await fs.rm(file);
      const { code, text, unsent } = await f.terminal([[PHONE, "n"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${PHONE}n\n\n${SECTION}${IS_ON}\n\n${COMMAND}\n`), `${mode}: ${text}`);
      assert.doesNotMatch(text, /Turn on Chrome|answer:/, mode);
      if (mode !== "missing") assert.equal(await read(), original, mode);
      assert.equal(await f.has(backup), false, mode);
    });
  }
});

test("on with no terminal: the same one check line", async () => {
  await withChrome("on", async ({ f }) => {
    const { code, text } = await f.piped();
    assert.equal(code, 0, text);
    assert.ok(text.includes(`${SECTION}${IS_ON}\n\n${COMMAND}\n`), text);
  });
});

test("off, Chrome closed, y: backed up beside it, switched on, everything else kept, one check line", async () => {
  for (const python of APPLE_PYTHON ? ["system", "apple"] : ["system"]) {
    await withChrome("off", async ({ f, original, read, backup }) => {
      const { code, text, unsent } = await f.terminal([[PHONE, "n"], ["answer: ", "y"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${PHONE}n\n\n${SECTION}${ASK}y\n\n${IS_ON}\n\n${COMMAND}\n`), `${python}: ${text}`);
      if (python === "apple") assert.ok((await f.calls()).includes(`apple python3 ${f.app}/facilitator`), python);
      const now = JSON.parse(await read());
      assert.deepEqual(now, { ...JSON.parse(original), hardware_acceleration_mode: { enabled: true } });
      assert.equal(await fs.readFile(backup, "utf8"), original);
      assert.doesNotMatch(text, /\n\n\n/);
    }, { python });
  }
});

test("off, Chrome closed, n: nothing printed after it, the file untouched, no backup; Enter and l are ignored", async () => {
  await withChrome("off", async ({ f, original, read, backup }) => {
    const { code, text, unsent } = await f.terminal([[PHONE, "n"], ["answer: ", "\rlxn"]]);
    assert.equal(code, 0, text);
    assert.deepEqual(unsent, []);
    assert.ok(text.includes(`${SECTION}${ASK}n\n\n${COMMAND}\n`), text);
    assert.equal(await read(), original);
    assert.equal(await f.has(backup), false);
  });
});

test("off, Chrome open, y: the steps, then the line to quit and reopen; Chrome is left running, the file untouched", async () => {
  await withChrome("off", async ({ f, folder, original, read, backup }) => {
    const chrome = await fakeChrome(folder);
    try {
      const { code, text, unsent } = await f.terminal([[PHONE, "n"], ["answer: ", "\rny"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${PHONE}n\n\n${SECTION}${STEPS}y\n\n${REOPEN}\n\n${COMMAND}\n`), text);
      assert.equal(chrome.alive(), true, "Chrome was quit by the installer");
      assert.equal(await read(), original);
      assert.equal(await f.has(backup), false);
    } finally { await chrome.quit(); }
  });
});

test("off, Chrome open, l: the steps and nothing after the answer; Chrome is left running, the file untouched", async () => {
  await withChrome("off", async ({ f, folder, original, read, backup }) => {
    const chrome = await fakeChrome(folder);
    try {
      const { code, text, unsent } = await f.terminal([[PHONE, "n"], ["answer: ", "l"]]);
      assert.equal(code, 0, text);
      assert.deepEqual(unsent, []);
      assert.ok(text.includes(`${SECTION}${STEPS}l\n\n${COMMAND}\n`), text);
      assert.doesNotMatch(text, /Quit and reopen/);
      assert.equal(chrome.alive(), true);
      assert.equal(await read(), original);
      assert.equal(await f.has(backup), false);
    } finally { await chrome.quit(); }
  });
});

test("off with no terminal, Chrome closed or open: nothing asked, nothing changed, one line", async () => {
  for (const open of [false, true]) {
    await withChrome("off", async ({ f, folder, original, read, backup }) => {
      const chrome = open ? await fakeChrome(folder) : null;
      try {
        const { code, text } = await f.piped();
        assert.equal(code, 0, text);
        assert.ok(text.includes(`${SECTION}⊘ Left Chrome's graphics acceleration off: there is no interactive terminal.\n\n${COMMAND}`), text);
        assert.doesNotMatch(text, /Turn on|answer:/);
        assert.equal(await read(), original);
        assert.equal(await f.has(backup), false);
      } finally { if (chrome) await chrome.quit(); }
    });
  }
});

test("a SingletonLock left behind by a crash does not count as Chrome open", async () => {
  await withChrome("off", async ({ f, folder }) => {
    await fs.symlink("Sandbox-Mac.local-999999", path.join(folder, "SingletonLock"));
    const { code, text } = await f.terminal([[PHONE, "n"], ["answer: ", "n"]]);
    assert.equal(code, 0, text);
    assert.ok(text.includes(`${SECTION}${ASK}n\n\n${COMMAND}\n`), text);
  });
});

test("a write that fails leaves Local State as it was and says so in one line", async () => {
  await withChrome("off", async ({ f, folder, original, read, backup }) => {
    await fs.chmod(folder, 0o555);
    const { code, text } = await f.terminal([[PHONE, "n"], ["answer: ", "y"]]);
    assert.equal(code, 0, text);
    assert.match(text, /\n⚠ Could not turn on graphics acceleration \([^\n]*\)\. Chrome's settings were left as they were\.\n\n✓ facilitator command/);
    assert.equal(await read(), original);
    assert.equal(await f.has(backup), false);
  });
});

test("Ctrl+C at the question ends the run in one sentence and changes nothing", async () => {
  await withChrome("off", async ({ f, original, read }) => {
    const { code, text } = await f.terminal([[PHONE, "n"], ["answer: ", "\x03"]]);
    assert.equal(code, 130, text);
    assert.match(text, /answer: (\n\^C|\^C)?\nExiting facilitator installer\.\n$/);
    assert.doesNotMatch(text, /Traceback|command and agent skill installed/);
    assert.equal(await read(), original);
  });
});
