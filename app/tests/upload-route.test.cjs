// The attachment upload route on its own: how long an upload may take, what it
// has to be, and what a retry under the same operation id gets. A copied server
// runs on a free port pair in a temp folder with its clocks shortened, and the
// requests are raw so their pacing is the test's own.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const STALL_S = 1.0;      // UPLOAD_STALL_TIMEOUT in this fixture
const LIMIT_S = 3.0;      // UPLOAD_TIME_LIMIT in this fixture
const BODY_S = 0.5;       // BODY_READ_TIMEOUT in this fixture, which uploads no longer answer to
const OP = "0123456789abcdef0123456789abcdef";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// the first bytes of a real file of each kind, padded so each is a few KiB
const HEADS = {
  png: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  jpg: Buffer.from("ffd8ffe000104a464946", "hex"),
  jpeg: Buffer.from("ffd8ffe000104a464946", "hex"),
  gif: Buffer.from("GIF89a"),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]),
  svg: Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>\n'),
  mp4: Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypmp42")]),
  m4v: Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypM4V ")]),
  mov: Buffer.concat([Buffer.from("00000014", "hex"), Buffer.from("ftypqt  ")]),
  webm: Buffer.from("1a45dfa39f4286810142f7810142f2", "hex"),
  ogv: Buffer.from("OggS\0\x02"),
  mp3: Buffer.from("ID3\x04\0\0\0\0\0\0"),
  m4a: Buffer.concat([Buffer.from("0000001c", "hex"), Buffer.from("ftypM4A ")]),
  aac: Buffer.from("fff15080", "hex"),
  wav: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]),
  ogg: Buffer.from("OggS\0\x02"),
  oga: Buffer.from("OggS\0\x02"),
  opus: Buffer.from("OggS\0\x02"),
  weba: Buffer.from("1a45dfa39f4286810142f7810142f2", "hex"),
  pdf: Buffer.from("%PDF-1.7\n"),
  doc: Buffer.from("d0cf11e0a1b11ae1", "hex"),
  docx: Buffer.from("504b0304", "hex"),
};
const fileOf = ext => ext === "svg" ? HEADS.svg : Buffer.concat([HEADS[ext], Buffer.alloc(4096, 7)]);

let outer, uploads, origin, port, child, output = "";

// one raw request: the body goes out in the pieces given, each after its own
// wait, and the answer is read whole. cut ends the socket after the pieces
function send(route, pieces, { method = "POST", cut = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", error => (cut ? resolve({ status: 0, error }) : reject(error)));
    req.flushHeaders();
    (async () => {
      for (const [wait, bytes] of pieces) {
        if (wait) await pause(wait);
        if (!req.destroyed) req.write(bytes);
      }
      if (cut) { await pause(100); req.destroy(); }
      else req.end();
    })();
  });
}
const upload = (name, bytes, extra = "") =>
  send("/upload?name=" + encodeURIComponent(name) + extra, [[0, bytes]]);
const stored = async () => (await readdir(uploads)).filter(name => !name.startsWith("."));
const parts = async () => (await readdir(uploads)).filter(name => name.endsWith(".part"));

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-upload-route-"));
  const app = path.join(outer, "app");
  uploads = path.join(outer, "facilitator-internal", "uploads");
  await mkdir(app);
  await mkdir(uploads, { recursive: true });
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  for (const [from, to] of [["PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"],
                            ["BODY_READ_TIMEOUT = 30.0", `BODY_READ_TIMEOUT = ${BODY_S}`],
                            ["UPLOAD_STALL_TIMEOUT = 60.0", `UPLOAD_STALL_TIMEOUT = ${STALL_S}`],
                            ["UPLOAD_TIME_LIMIT = 3600.0", `UPLOAD_TIME_LIMIT = ${LIMIT_S}`]]) {
    const patched = source.replace(from, to);
    assert.notEqual(patched, source, `fixture patch did not apply: ${from}`);
    source = patched;
  }
  await writeFile(path.join(app, "server.py"), source);
  copyBridgeFiles(app);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({ title: "Upload fixture", items: [
    { id: "0", bucket: "meta", title: "Fixture card", owner: "facilitator", context: "Invented fixture" }] }));
  // a part left by a server that stopped mid-upload long ago, and one young
  // enough that it could still be another server's
  await writeFile(path.join(uploads, ".1-old.part"), "left behind");
  const old = new Date(Date.now() - (LIMIT_S + 60) * 1000);
  await utimes(path.join(uploads, ".1-old.part"), old, old);
  await writeFile(path.join(uploads, ".2-young.part"), "still coming");
  port = await freePortPair();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(PYTHON, [path.join(app, "server.py")], {
    cwd: app, env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes; });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(origin + "/op?id=fixture-probe-01")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("fixture did not start: " + output);
    await pause(25);
  }
});

after(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("startup clears a part file older than an upload may take and keeps a young one", async () => {
  const left = await parts();
  assert.ok(!left.includes(".1-old.part"), "the stale part survived the start");
  assert.ok(left.includes(".2-young.part"), "a part that could still be arriving was removed");
});

test("a steady upload that takes longer than the old body clock is stored whole and owner-only", async () => {
  const piece = Buffer.alloc(32 * 1024, 5);
  const pieces = [[0, fileOf("mp4")]];
  for (let i = 0; i < 5; i++) pieces.push([400, piece]);   // about 2 s: four times BODY_READ_TIMEOUT
  const started = Date.now();
  const answer = await send("/upload?name=" + encodeURIComponent("Slow clip.mp4"), pieces);
  const took = (Date.now() - started) / 1000;
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.ok(took > BODY_S * 3, `the upload ran ${took.toFixed(1)} s, not longer than the body clock`);
  assert.match(answer.json.url, /^\/uploads\/\d+-Slow%20clip\.mp4$/);
  const name = decodeURIComponent(answer.json.url.slice("/uploads/".length));
  const kept = await readFile(path.join(uploads, name));
  assert.deepEqual(kept, Buffer.concat(pieces.map(([, bytes]) => bytes)));
  assert.equal((await stat(path.join(uploads, name))).mode & 0o777, 0o600, "the stored file is readable by others");
  const served = await fetch(origin + answer.json.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "video/mp4");
});

test("an upload that goes quiet is cut on the silence clock and leaves nothing behind", async () => {
  const before = await stored();
  const started = Date.now();
  const answer = await send("/upload?name=quiet.mp4", [[0, fileOf("mp4")], [(STALL_S + 1.5) * 1000, Buffer.alloc(10)]]);
  const took = (Date.now() - started) / 1000;
  assert.equal(answer.status, 408);
  assert.match(answer.json.error, /stopped arriving/);
  assert.ok(took >= STALL_S * 0.8 && took < STALL_S + 2.5, `the silence clock ran ${took.toFixed(2)} s`);
  assert.deepEqual(await stored(), before);
  assert.deepEqual((await parts()).filter(name => name !== ".2-young.part"), []);
});

test("an upload that keeps dripping past the whole limit is cut too", async () => {
  const pieces = [[0, fileOf("mp4")]];
  for (let i = 0; i < 10; i++) pieces.push([STALL_S * 500, Buffer.alloc(1024, 1)]);  // 5 s, never silent
  const answer = await send("/upload?name=drip.mp4", pieces);
  assert.equal(answer.status, 408);
  assert.match(answer.json.error, /longer than an hour/);
  assert.deepEqual((await parts()).filter(name => name !== ".2-young.part"), []);
});

test("every allowed kind is stored when its first bytes are that kind", async () => {
  for (const ext of Object.keys(HEADS)) {
    const bytes = fileOf(ext);
    const answer = await upload("Kind check." + ext.toUpperCase(), bytes);
    assert.equal(answer.status, 200, ext + " " + JSON.stringify(answer.json));
    const served = await fetch(origin + answer.json.url);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes, ext);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff", ext);
    assert.equal(served.headers.get("content-security-policy"), "sandbox", ext);
  }
});

test("a file whose bytes are not what its name says is refused in plain words", async () => {
  const before = await stored();
  const page = Buffer.from("<!doctype html><html><body><script>parent.pwned = 1</script></body></html>");
  const cases = [["holiday.png", page, /not a PNG picture/], ["clip.mp4", page, /not an MP4 video/],
                 ["notes.pdf", Buffer.from("just text"), /not a PDF/], ["report.docx", page, /not a Word document/],
                 ["photo.jpg", fileOf("png"), /not a JPEG picture/]];
  for (const [name, bytes, words] of cases) {
    const answer = await upload(name, bytes);
    assert.equal(answer.status, 415, name);
    assert.match(answer.json.error, words, name);
    assert.match(answer.json.error, /so it was not attached\.$/, name);
  }
  assert.deepEqual(await stored(), before, "a refused file was kept");
});

test("an SVG that carries script is refused, however the script is carried", async () => {
  const svgs = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK = "alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>go</text></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="/"></iframe></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" title="a>b" onload="alert(1)"/>',
    // a handler far into a large file, across the scan's own read boundary
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>' + "x".repeat(1024 * 1024 - 40) + '</desc><g onmouseover="alert(1)"/></svg>',
  ];
  for (const svg of svgs) {
    const answer = await upload("drawing.svg", Buffer.from(svg));
    assert.equal(answer.status, 415, svg.slice(0, 80));
    assert.match(answer.json.error, /SVG carries script/);
  }
  const clean = await upload("clean.svg", HEADS.svg);
  assert.equal(clean.status, 200);
  const served = await fetch(origin + clean.json.url);
  assert.equal(served.headers.get("content-type"), "image/svg+xml");
  assert.equal(served.headers.get("content-security-policy"), "sandbox");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
});

test("empty, oversized and unlisted uploads are refused before anything is kept", async () => {
  const before = await stored();
  const empty = await upload("empty.pdf", Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /empty/);
  const listed = await upload("page.html", fileOf("pdf"));
  assert.equal(listed.status, 415);
  assert.match(listed.json.error, /cannot be attached/);
  const large = await send("/upload?name=large.pdf", [], { headers: { "Content-Length": String(100 * 1024 * 1024 + 1) }, cut: true });
  assert.equal(large.status, 413);
  assert.match(large.json.error, /larger than 100 MiB/);
  assert.deepEqual(await stored(), before);
});

test("a retry under the same operation id gets the stored file, never a second copy", async () => {
  const bytes = fileOf("png");
  const first = await upload("retry.png", bytes, "&op=" + OP);
  assert.equal(first.status, 200);
  const count = (await stored()).length;
  const receipt = await send("/upload?op=" + OP, [], { method: "GET" });
  assert.equal(receipt.status, 200);
  assert.deepEqual(receipt.json, { url: first.json.url, size: bytes.length });
  const again = await upload("retry.png", bytes, "&op=" + OP);
  assert.equal(again.status, 200);
  assert.equal(again.json.url, first.json.url);
  assert.equal(again.json.replayed, true);
  assert.equal((await stored()).length, count, "the retry stored a second copy");
  const other = await upload("other.png", bytes, "&op=" + OP);
  assert.equal(other.status, 409);
  assert.match(other.json.error, /another file/);
  assert.equal((await send("/upload?op=" + "f".repeat(32), [], { method: "GET" })).status, 404);
  assert.equal((await send("/upload?op=../../x", [], { method: "GET" })).status, 400);
  assert.equal((await upload("bad.png", bytes, "&op=not-an-id")).status, 400);
});

test("an upload still arriving says so, and a second start under its id is refused", async () => {
  const op = "abcdefabcdefabcdefabcdefabcdef01";
  const slow = send("/upload?name=arriving.mp4&op=" + op, [[0, fileOf("mp4")], [600, Buffer.alloc(8)], [600, Buffer.alloc(8)]]);
  await pause(300);
  const receipt = await send("/upload?op=" + op, [], { method: "GET" });
  assert.deepEqual(receipt.json, { arriving: true });
  const twin = await upload("arriving.mp4", fileOf("mp4"), "&op=" + op);
  assert.equal(twin.status, 409);
  assert.match(twin.json.error, /still arriving/);
  const done = await slow;
  assert.equal(done.status, 200);
  assert.equal((await send("/upload?op=" + op, [], { method: "GET" })).json.url, done.json.url);
});

test("a caller that hangs up mid-upload leaves no file and one line saying how far it got", async () => {
  const before = await stored();
  const cut = await send("/upload?name=cut.mp4", [[0, fileOf("mp4")], [200, Buffer.alloc(20000, 3)]],
                         { cut: true, headers: { "Content-Length": String(1024 * 1024) } });
  assert.equal(cut.status, 0);
  await pause(400);
  assert.deepEqual(await stored(), before);
  assert.deepEqual((await parts()).filter(name => name !== ".2-young.part"), []);
  const logs = path.join(outer, "logs");
  const text = (await Promise.all((await readdir(logs)).map(name => readFile(path.join(logs, name), "utf8")))).join("\n");
  assert.match(text, /uploadcut/);
  assert.doesNotMatch(text, /cut\.mp4/, "the log names the file");
});
