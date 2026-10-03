// A picture an agent puts in a lane's internal folder for the panel is served
// the way an upload is: its type cannot be reinterpreted and it sits in a
// sandbox, so a picture that carries script (an SVG can) can never run it,
// however it is opened. The lane folder's fence is untouched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { mkdir, symlink, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

let board, folder;

const PICTURES = {
  png: Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(64, 7)]),
  jpg: Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(64, 7)]),
  jpeg: Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(64, 7)]),
  gif: Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 7)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 7)]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>1</script><rect width="8" height="8"/></svg>'),
};
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml" };

before(async () => {
  board = await startBoard();
  folder = path.join(board.app, "facilitator-internal");
  await mkdir(folder, { recursive: true });
  for (const [ext, bytes] of Object.entries(PICTURES)) await writeFile(path.join(folder, `panel.${ext}`), bytes);
  await writeFile(path.join(folder, "panel.pdf"), "%PDF-1.7\n");
  await writeFile(path.join(board.outer, "secret.png"), PICTURES.png);
  await symlink(path.join(board.outer, "secret.png"), path.join(folder, "escape.png"));
});

after(async () => { if (board) await board.stop(); });

test("every kind of panel picture is served unable to be reinterpreted or to run anything", async () => {
  for (const [ext, bytes] of Object.entries(PICTURES)) {
    const response = await fetch(`${board.origin}/laneimg/facilitator/panel.${ext}`);
    assert.equal(response.status, 200, ext);
    assert.equal(response.headers.get("content-type"), TYPES[ext], ext);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", ext);
    assert.equal(response.headers.get("content-security-policy"), "sandbox", ext);
    assert.equal(response.headers.get("cache-control"), "no-store", ext);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, `${ext}: the bytes are what was written`);
  }
});

test("the lane folder's fence still holds", async () => {
  for (const route of ["/laneimg/facilitator/panel.pdf", "/laneimg/facilitator/escape.png",
    "/laneimg/facilitator/..%2Fsecret.png", "/laneimg/facilitator/none.png", "/laneimg/nobody/panel.png",
    "/laneimg/facilitator/"])
    assert.equal((await fetch(board.origin + route)).status, 404, route);
});
