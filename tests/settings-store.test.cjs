// The board's settings store: the desktop pages' layouts, hides, colours and
// the rest, kept in settings.json beside state.json instead of one browser's
// storage. The routes refuse what is not a setting, merge writes key by key,
// take a browser's one-time copy only while the store is empty, survive a
// restart, and never move the board's own revision, so a box dragged on the
// desktop sends no phone a new board. One sandbox board on its own free pair.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const box = require("./board-sandbox.cjs");

let place, port, run;
const url = route => `http://127.0.0.1:${port}${route}`;
const read = async () => (await fetch(url("/settings"))).json();
const write = (body, query = "") => fetch(url("/settings" + query), { method: "POST", body: JSON.stringify(body) });

before(async () => {
  port = await box.freePortPair();
  place = box.sandbox("settings-store", { config: { port } });
  run = box.launch(place);
  await box.waitReady(run, port);
});

after(async () => { if (place) await box.cleanup(place); });

test("a browser's one-time copy lands only on an empty store", async () => {
  assert.deepEqual(await read(), { rev: 0, values: {} });
  const copy = { "pos.facilitator.main": '{"x":40,"y":60}', "hide.facilitator.rail": "1", bgcolor: "#f3efe6" };
  const first = await (await write(copy, "?seed=1")).json();
  assert.equal(first.seeded, true);
  assert.deepEqual(first.values, copy);
  const second = await (await write({ bgcolor: "#000000", "tocw": "300" }, "?seed=1")).json();
  assert.equal(second.seeded, false, "a second browser's copy landed on a store that already had one");
  assert.deepEqual(second.values, copy, "the refused copy changed the store");
  assert.equal(second.rev, first.rev);
});

test("unknown keys and long values are refused whole, with nothing stored", async () => {
  const before = await read();
  for (const body of [
    { "spot.access": "a sign-in is not a setting" },
    { selbox: "7" },                                  // which card is open stays per window
    { "pos.facilitator.main": "x".repeat(65537) },
    { "pos.facilitator.main": 12 },
    { "tocw": "260", "activeproj": "facilitator" },   // one bad key spoils the batch
    { "pos.facilitator.bad id!": "{}" },
  ]) {
    const res = await write(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await write([])).status, 400);
  assert.equal((await fetch(url("/settings"), { method: "POST", body: "not json" })).status, 400);
  assert.deepEqual(await read(), before, "a refused write changed the store");
  // the longest value allowed, and a lane id with letters of its own, are fine
  assert.equal((await write({ "doc.tasks.facilitator": "x".repeat(65536) })).status, 200);
  assert.equal((await write({ "pos.café-2.magic1": '{"x":1,"y":2}' })).status, 200);
});

test("two windows writing different keys both keep theirs, and the last write to one key wins", async () => {
  await Promise.all([
    write({ "pos.facilitator.clockbox": '{"x":10,"y":10}' }),
    write({ "size.facilitator.clockbox": '{"w":200,"h":90}' }),
    write({ "show.facilitator.magic1": "1" }),
  ]);
  let values = (await read()).values;
  assert.equal(values["pos.facilitator.clockbox"], '{"x":10,"y":10}');
  assert.equal(values["size.facilitator.clockbox"], '{"w":200,"h":90}');
  assert.equal(values["show.facilitator.magic1"], "1");
  await write({ bgcolor: "#111111" });
  await write({ bgcolor: "#222222" });
  assert.equal((await read()).values.bgcolor, "#222222");
  // null takes a key away and leaves the rest
  await write({ "show.facilitator.magic1": null });
  values = (await read()).values;
  assert.equal("show.facilitator.magic1" in values, false);
  assert.equal(values["pos.facilitator.clockbox"], '{"x":10,"y":10}');
});

test("a settings write moves settingsRev and never the board's revision", async () => {
  const board = await (await fetch(url("/state"))).json();
  const phone = await (await fetch(url("/m/state"))).json();
  const answer = await (await write({ composeformat: "1" })).json();
  const after = await (await fetch(url("/state"))).json();
  assert.equal(after.rev, board.rev, "a settings write moved the board's revision");
  assert.equal(after.settingsRev, answer.rev);
  assert.ok(after.settingsRev > board.settingsRev);
  const phoneAfter = await (await fetch(url(`/m/state?since=${phone.rev}`))).json();
  assert.equal(phoneAfter.rev, phone.rev);
  assert.equal(phoneAfter.changed, false, "the phone was sent the board again for a settings write");
});

test("the settings outlive a restart, owner-only, and a file that cannot be read is put aside", async () => {
  const kept = await read();
  const file = path.join(place.app, "settings.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  run.child.kill("SIGTERM");
  await once(run.child, "exit");
  run = box.launch(place);
  await box.waitReady(run, port);
  assert.deepEqual(await read(), kept);

  run.child.kill("SIGTERM");
  await once(run.child, "exit");
  fs.writeFileSync(file, "{ half a file");
  run = box.launch(place);
  await box.waitReady(run, port);
  assert.deepEqual(await read(), { rev: 0, values: {} });
  const aside = fs.readdirSync(place.app).filter(name => name.startsWith("settings.json.bad-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(place.app, aside[0]), "utf8"), "{ half a file");
  assert.ok(box.events(place).some(event => event.kind === "settingsbad"));
});
