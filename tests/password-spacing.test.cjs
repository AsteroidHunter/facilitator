// The printed layout of `facilitator password set`, checked line for line.
//
// cmd_password runs in a python subprocess inside a disposable copy of the
// script and bridge_auth.py, with getpass replaced by canned answers and
// bridge_auth pointed at a temporary auth file, so the real bridge-auth.json
// is never read or written. The fake getpass echoes each prompt to stdout the
// way a terminal shows it, so the whole screen can be compared exactly.
const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { execFile } = require('node:child_process');
const { access, copyFile, mkdtemp, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || 'python3';
const PASS = 'ExampleBridge7!';
const dirs = [];

after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

async function passwordScreen(answers, { installer = false } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'facilitator-password-')));
  dirs.push(dir);
  for (const name of ['facilitator', 'bridge_auth.py']) await copyFile(path.join(ROOT, name), path.join(dir, name));
  const script = [
    'import getpass, sys',
    'from pathlib import Path',
    'from importlib.machinery import SourceFileLoader',
    'import bridge_auth',
    `bridge_auth.AUTH_FILE = Path(${JSON.stringify(path.join(dir, 'bridge-auth.json'))})`,
    'bridge_auth.LOCK_FILE = bridge_auth.AUTH_FILE.with_suffix(".lock")',
    'cli = SourceFileLoader("facilitator_cli", "facilitator").load_module()',
    'class Input:',
    '    def isatty(self): return True',
    'sys.stdin = Input()',
    `values = iter(${JSON.stringify(answers)})`,
    'def fake_getpass(prompt):',
    '    print(prompt.rstrip())',
    '    return next(values)',
    'getpass.getpass = fake_getpass',
    installer ? 'cli.cmd_password(["_password-setup"], installer=True)'
              : 'cli.cmd_password(["password", "set"])',
    'assert next(values, None) is None, "answers left over"',
  ].join('\n');
  const { stdout } = await run(PYTHON, ['-c', script], { cwd: dir });
  await access(path.join(dir, 'bridge-auth.json'));
  return stdout;
}

const INTRO = [
  'Choose a strong password to log into your Facilitator phone app.',
  'Use at least 11 characters, with a letter, a number and a symbol.',
];
const PAIR = ['App password (input hidden):', 'Confirm app password (input hidden):'];

test('a mismatch then a match prints separated groups with the prompt pair kept together', async () => {
  const stdout = await passwordScreen([PASS, 'ExampleBridge8!', PASS, PASS]);
  assert.equal(stdout, [
    ...INTRO, '',
    ...PAIR, '',
    'The passwords did not match. Try both entries again.', '',
    ...PAIR, '',
    'App password confirmed. Existing phone sessions were signed out.',
  ].join('\n') + '\n');
  assert.equal(stdout.includes(PASS), false, 'a password was printed');
});

test('a rule failure prints the rule on its own between blank lines', async () => {
  const stdout = await passwordScreen(['short2!', PASS, PASS]);
  assert.equal(stdout, [
    ...INTRO, '',
    'App password (input hidden):', '',
    'Use 11 to 256 characters, with a letter, a number and a symbol.', '',
    ...PAIR, '',
    'App password confirmed. Existing phone sessions were signed out.',
  ].join('\n') + '\n');
});

test('the installer path keeps the same groups and ends without a trailing blank line', async () => {
  const stdout = await passwordScreen(['', PASS, 'mismatch', PASS, PASS], { installer: true });
  assert.equal(stdout, [
    ...INTRO, '',
    'App password (input hidden):', '',
    'That was empty. Choose a strong passphrase.', '',
    ...PAIR, '',
    'The passwords did not match. Try both entries again.', '',
    ...PAIR, '',
    'App password confirmed.',
  ].join('\n') + '\n');
});
