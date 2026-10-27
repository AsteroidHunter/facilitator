// `facilitator magic`, the one call an agent makes to open, fill and close
// a card's magic box on its own. A copy of the command runs beside a fixture
// board on spare ports, finding the port the way it does on a real install,
// in the run.config.json beside it, and the board's agent key in data/ beside
// it: the board is locked as a real one is, so every call carries the key. No
// browser is started and no site is asked for: the web addresses used here
// are refused before any fetch.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { ROOT, startBoard } = require("./board-fixture.cjs");
const { appFolder, dataOf } = require("./fixture-auth.cjs");

let board, cli;
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(64, 7)]);

before(async () => {
  board = await startBoard({ lock: true });
  cli = path.join(board.app, "facilitator");
  await copyFile(path.join(ROOT, "facilitator"), cli);
  await copyFile(path.join(ROOT, "data_folder.py"), path.join(path.dirname(cli), "data_folder.py"));
  await writeFile(path.join(board.data, "run.config.json"), JSON.stringify({ port: board.port, lanes: [] }));
});
after(async () => { if (board) await board.stop(); });

function magic(args, input, command = cli, name = "magic") {
  const run = spawnSync("python3", [command, name, ...args], {
    encoding: "utf8", input, timeout: 60000,
    env: { ...process.env, FACILITATOR_LOG_DIR: path.join(board.outer, "cli-logs") },
  });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}
const body = async id => (await fetch(`${board.origin}/magic/body?box=${id}`, { headers: board.keyed() })).json();

test("each kind fills the card's magic box from an argument, a file or standard input", async () => {
  // a card never filled has none to show, and says so
  let run = magic(["0", "show"]);
  assert.deepEqual([run.code, run.out, run.err], [1, "", "magic: this card has no magic box"]);
  run = magic(["0", "text", "plain *words*", "--title", "Words"]);
  assert.equal(run.code, 0, run.err);
  const answer = JSON.parse(run.out);
  assert.deepEqual([answer.ok, answer.box, answer.kind, answer.shown], [true, "0", "text", "inline"]);
  assert.deepEqual([(await body("0")).text, (await body("0")).title], ["plain *words*", "Words"]);

  const notes = path.join(board.outer, "notes.md");
  await writeFile(notes, "# Heading\n\n- one\n");
  run = magic(["0", "markdown", "--file", notes]);
  assert.equal(run.code, 0, run.err);
  assert.equal((await body("0")).text, "# Heading\n\n- one");

  run = magic(["0", "html", "-"], "<!doctype html><p>made here</p>");
  assert.equal(run.code, 0, run.err);
  assert.equal((await body("0")).html, "<!doctype html><p>made here</p>");

  const picture = path.join(board.outer, "plot.png");
  await writeFile(picture, PNG);
  run = magic(["0", "image", "--file", picture]);
  assert.equal(run.code, 0, run.err);
  const shown = await body("0");
  assert.equal(shown.kind, "image");
  assert.deepEqual(Buffer.from(await (await fetch(board.origin + shown.src, { headers: board.keyed() })).arrayBuffer()), PNG);
});

test("close hides the magic box, reopen shows it, show prints what it holds", async () => {
  assert.equal(magic(["1.1", "text", "for the lane card"]).code, 0);
  let run = magic(["1.1", "close"]);
  assert.equal(run.code, 0, run.err);
  assert.equal(JSON.parse(run.out).open, false);
  run = magic(["1.1", "show"]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual([JSON.parse(run.out).open, JSON.parse(run.out).kind], [false, "text"]);
  run = magic(["1.1", "reopen"]);
  assert.equal(JSON.parse(run.out).open, true);
});

test("--widget makes a page a widget, answer puts the agent's answer in it and widget prints its record", async () => {
  let run = magic(["1.1", "html", "<p>a widget</p>", "--widget", "issues"]);
  assert.equal(run.code, 0, run.err);
  assert.equal(JSON.parse(run.out).widget, "issues");
  run = magic(["1.1", "answer", "t3-sound", "Yes, it plays once.", "--agent", "opus"]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual([JSON.parse(run.out).ok, JSON.parse(run.out).answered, JSON.parse(run.out).released], [true, 0, false]);
  run = magic(["1.1", "answer", "", "-"], "about nothing in particular");
  assert.equal(run.code, 0, run.err);
  run = magic(["1.1", "widget"]);
  assert.equal(run.code, 0, run.err);
  const record = JSON.parse(run.out);
  assert.deepEqual(record.thread.map(m => [m.by, m.about, m.text, m.agent]),
    [["agent", "t3-sound", "Yes, it plays once.", "opus"], ["agent", "", "about nothing in particular", undefined]]);
  // what the board refuses, and what the command refuses before asking it
  for (const [args, words] of [[["0", "answer", "t1", "no widget here"], /^magic: this card's box is not a widget$/],
    [["1.1", "answer", "t 1", "x"], /^magic: about is one id/], [["1.1", "text", "x", "--widget", "issues"], /only an html page/],
    [["1.1", "answer"], /^magic: answer needs the id/], [["1.1", "widget", "extra"], /^magic: widget takes only the card$/],
    [["1.1", "text", "x", "--agent", "opus"], /^magic: --agent goes with answer$/]]) {
    run = magic(args);
    assert.equal(run.code, 1, args.join(" "));
    assert.match(run.err, words, args.join(" "));
  }
});

test("the board's refusals come back in its own words with exit 1", () => {
  const cases = [
    [["nope", "text", "x"], /^magic: bad box$/],
    [["0", "url", "http://example.org/"], /^magic: only https addresses can be shown$/],
    [["0", "url", "https://192.168.1.1/"], /home network/],
    [["0", "image", "not a picture at all"], /not a PNG, JPEG, GIF, WebP or SVG picture/],
    [["1.1.1", "close"], /^magic: bad box$/],
    [["0", "text", "   "], /^magic: the box would be empty$/],
    [["0", "url", "https://example.org/\nhttps://example.com/"], /^magic: a website box takes one web address on one line$/],
  ];
  for (const [args, words] of cases) {
    const run = magic(args);
    assert.equal(run.code, 1, args.join(" "));
    assert.match(run.err, words, args.join(" "));
    assert.equal(run.out, "");
  }
});

test("what the command cannot send is refused before the board is asked", () => {
  for (const args of [["0", "text"], ["0", "text", "a", "b"], ["0", "text", "a", "--file", "x"],
    ["0", "close", "extra"], ["0", "video", "x"], ["0", "text", "--title"], ["0", "markdown", "--file", "/no/such/file.md"]]) {
    const run = magic(args);
    assert.equal(run.code, 1, args.join(" "));
    assert.match(run.err, /^magic: /, args.join(" "));
  }
  assert.equal(magic(["0"]).code, 1);
  const help = magic(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /^usage: facilitator magic CARD KIND/);
  assert.match(help.out, /Fill a card's magic box on the Mac board/);
  assert.doesNotMatch(help.out, /side ?note/i);
});

test("the side note name is gone: `facilitator sidenote` is no command, and fills nothing", async () => {
  const before = await body("0");
  const run = magic(["0", "text", "by the other name"], undefined, cli, "sidenote");
  assert.equal(run.code, 1);
  assert.equal(run.out, "");
  assert.match(run.err, /facilitator magic CARD KIND/);
  assert.doesNotMatch(run.err, /side ?note/i);
  assert.deepEqual(await body("0"), before);
});

test("a board that is down is said so, with exit 1", async () => {
  const folder = appFolder("facilitator-magic-down-");
  try {
    const port = await new Promise(resolve => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
    await mkdir(folder, { recursive: true });
    await copyFile(path.join(ROOT, "facilitator"), path.join(folder, "facilitator"));
    await copyFile(path.join(ROOT, "data_folder.py"), path.join(path.dirname(path.join(folder, "facilitator")), "data_folder.py"));
    await writeFile(path.join(dataOf(folder), "run.config.json"), JSON.stringify({ port, lanes: [] }));
    const run = magic(["0", "text", "x"], undefined, path.join(folder, "facilitator"));
    assert.equal(run.code, 1);
    assert.equal(run.err, `server: DOWN (port ${port})`);
  } finally {
    await rm(path.dirname(folder), { recursive: true, force: true });
  }
});

test("the command's help names the subcommand", () => {
  const run = spawnSync("python3", [cli, "no-such-command"], { encoding: "utf8" });
  assert.match(run.stderr, /facilitator magic CARD KIND \(CONTENT \| --file PATH \| -\) \[--title TITLE\]/);
  assert.match(run.stderr, /facilitator magic CARD close\|reopen\|show/);
  assert.match(run.stderr, /fill a card's magic box, the box beside the card/);
  assert.doesNotMatch(run.stderr, /side ?note/i);
});
