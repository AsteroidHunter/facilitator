// claude-statusline.py: the status line command that keeps Claude Code's two
// plan windows for the limits box. Each run is on a copy of the script in a
// folder of its own, since the script writes beside itself. The input is what
// Claude Code sends on stdin, with invented numbers.
const assert = require("node:assert/strict");
const { after, beforeEach, test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROOT, PYTHON } = require("./limits-fixture.cjs");

const FUTURE = 4102444800;
const PAST = 1000000000;
const folders = [];
let dir, script, out;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-statusline-")));
  folders.push(dir);
  script = path.join(dir, "claude-statusline.py");
  out = path.join(dir, "claude-limits.json");
  fs.copyFileSync(path.join(ROOT, "claude-statusline.py"), script);
});
after(() => { for (const d of folders) fs.rmSync(d, { recursive: true, force: true }); });

// the input of one Claude Code reply: much more than the limits, all of which stays out of the file
const session = rate => JSON.stringify({
  session_id: "abc-123", transcript_path: "/invented/session.jsonl", cwd: "/invented/project",
  model: { id: "claude-invented", display_name: "Invented" },
  workspace: { current_dir: "/invented/project", project_dir: "/invented/project" },
  version: "9.9.9", cost: { total_cost_usd: 1.25 }, context_window: { used_percentage: 12 },
  ...(rate === undefined ? {} : { rate_limits: rate }),
});
const run = (input, ...args) => {
  const done = spawnSync(PYTHON, [script, ...args], { input, encoding: "utf8", timeout: 20000 });
  assert.equal(done.status, 0, `exit ${done.status}: ${done.stderr}`);
  return done;
};
const stored = () => JSON.parse(fs.readFileSync(out, "utf8"));

test("it writes the two windows and prints a short line", () => {
  const done = run(session({
    five_hour: { used_percentage: 23.5, resets_at: FUTURE },
    seven_day: { used_percentage: 41.2, resets_at: FUTURE + 1 },
  }));
  assert.deepEqual(stored(), {
    five_hour: { used_percentage: 23.5, resets_at: FUTURE },
    seven_day: { used_percentage: 41.2, resets_at: FUTURE + 1 },
  });
  assert.equal(done.stdout, "5h 24%  wk 41%\n");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["claude-limits.json", "claude-statusline.py"], "no temporary file is left");
});

test("nothing else of the input reaches the file, not even inside a window", () => {
  run(session({
    five_hour: { used_percentage: 5, resets_at: FUTURE, note: "invented", model: "x" },
    seven_day: { used_percentage: 6, resets_at: FUTURE, per_model: { opus: 90 } },
    sonnet_only: { used_percentage: 99, resets_at: FUTURE },
  }));
  const text = fs.readFileSync(out, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text)), ["five_hour", "seven_day"]);
  for (const w of Object.values(JSON.parse(text))) assert.deepEqual(Object.keys(w), ["used_percentage", "resets_at"]);
  assert.doesNotMatch(text, /invented|abc-123|opus|sonnet|cwd|cost/);
});

test("a window is replaced only when the input has it, and an input without limits changes nothing", () => {
  run(session({ five_hour: { used_percentage: 10, resets_at: FUTURE }, seven_day: { used_percentage: 20, resets_at: FUTURE } }));
  // only the weekly window this time
  const weekly = run(session({ seven_day: { used_percentage: 21, resets_at: FUTURE } }));
  assert.deepEqual(stored(), {
    five_hour: { used_percentage: 10, resets_at: FUTURE }, seven_day: { used_percentage: 21, resets_at: FUTURE } });
  assert.equal(weekly.stdout, "5h 10%  wk 21%\n");
  const before = fs.readFileSync(out, "utf8");
  // no limits at all: an API plan, or the first moments of a session
  for (const input of [session(), session({}), session({ five_hour: null }), "", "{not json", "[]", "null", "\u0000ÿ"]) {
    const done = run(input);
    assert.equal(fs.readFileSync(out, "utf8"), before, JSON.stringify(input).slice(0, 40));
    assert.equal(done.stdout, "5h 10%  wk 21%\n");
  }
  // a number that is not a number is not a window
  run(session({ five_hour: { used_percentage: true, resets_at: FUTURE }, seven_day: { used_percentage: "9" } }));
  assert.equal(fs.readFileSync(out, "utf8"), before);
});

test("with nothing to show it prints nothing and makes no file", () => {
  const done = run(session());
  assert.equal(done.stdout, "");
  assert.equal(fs.existsSync(out), false);
});

test("a window whose reset time has passed is printed as 0%, and the file keeps what Claude Code sent", () => {
  const done = run(session({ five_hour: { used_percentage: 80, resets_at: PAST }, seven_day: { used_percentage: 3, resets_at: FUTURE } }));
  assert.equal(done.stdout, "5h 0%  wk 3%\n");
  assert.equal(stored().five_hour.used_percentage, 80);
});

test("a status line that was already there keeps working: it gets the input and its output is the line", () => {
  const input = session({ five_hour: { used_percentage: 30, resets_at: FUTURE } });
  const done = run(input, "cat");
  assert.equal(done.stdout, input, "the input reaches it unchanged, and its output is all that is printed");
  assert.equal(stored().five_hour.used_percentage, 30, "and the limits are kept all the same");
  // one that prints its own line
  const mine = run(input, `${JSON.stringify(PYTHON)} -c "import json, sys; print('on ' + json.load(sys.stdin)['model']['display_name'])"`);
  assert.equal(mine.stdout, "on Invented\n");
  // one that fails, or is not there, prints nothing and stops nothing
  assert.equal(run(input, "exit 3").stdout, "");
  assert.equal(run(input, "no-such-command-here").stdout, "");
});
