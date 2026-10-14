// Where the server listens and how many of it a folder may run. The server
// binds the pair run.config.json names, the port and the one above it, with
// no text swapped in its copy and no test variable set. And since the pair can
// now move, the bind no longer stops a second server from the same folder: a
// lock does, and it refuses that second server before it reads state.json.
// Every port here comes from the operating system; nothing touches 8877.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const box = require("./board-sandbox.cjs");

test("the server binds the pair run.config.json names, and its lock says so", async () => {
  const source = fs.readFileSync(path.join(box.ROOT, "server.py"), "utf8");
  // the older tests swap this text for their port; it has to be there, once
  assert.equal(source.split("PORT = 8877").length - 1, 1, "the default port line is not there exactly once");
  const port = await box.freePortPair();
  const place = box.sandbox("port-pair", { config: { port } });
  try {
    const run = box.launch(place);
    await box.waitReady(run, port);
    const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
    assert.equal(state.pwd, place.app);
    // the phone's socket is the one above, behind its gate
    const gate = await (await fetch(`http://127.0.0.1:${port + 1}/auth/check`)).json();
    assert.equal(typeof gate.configured, "boolean");
    const held = JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8"));
    assert.deepEqual(held, { pid: run.child.pid, port, bridge: port + 1 });
    const start = box.events(place).find(event => event.kind === "start");
    assert.equal(start.port, port);
  } finally {
    await box.cleanup(place);
  }
});

test("a second server from the same folder on another pair is refused by the lock before it reads state.json", async () => {
  const port = await box.freePortPair();
  const place = box.sandbox("port-lock", { config: { port } });
  try {
    const first = box.launch(place);
    await box.waitReady(first, port);
    const statePath = path.join(place.app, "state.json");
    const kept = fs.readFileSync(statePath, "utf8");
    // a state file that cannot be read: a second server that read it would
    // crash on it, and one that saved would replace it
    fs.writeFileSync(statePath, "this is not json {");
    let other = await box.freePortPair();
    while (Math.abs(other - port) < 2) other = await box.freePortPair();
    const second = box.launch(place, { FACILITATOR_TEST_PORT: String(other) });
    const [code] = await once(second.child, "exit");
    assert.equal(code, 1, second.output);
    assert.equal(second.output, "", "the refused start wrote to its output");
    assert.equal(fs.readFileSync(statePath, "utf8"), "this is not json {", "the refused server touched state.json");
    const lines = box.events(place);
    const refused = lines.filter(event => event.kind === "lockfail");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].level, "error");
    assert.equal(refused[0].port, other);
    assert.equal(lines.filter(event => event.kind === "crash").length, 0, "the refused server crashed instead");
    assert.equal(lines.filter(event => event.kind === "start").length, 1, "the refused server said it started");
    // it let go of both of its ports on the way out
    for (const p of [other, other + 1]) {
      const probe = require("node:net").createServer();
      await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(p, "127.0.0.1", resolve); });
      await new Promise(resolve => probe.close(resolve));
    }
    fs.writeFileSync(statePath, kept);
    // the first one never noticed, and still holds the lock and the pair
    assert.ok((await fetch(`http://127.0.0.1:${port}/state`)).ok);
    const held = JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8"));
    assert.equal(held.pid, first.child.pid);
  } finally {
    await box.cleanup(place);
  }
});

test("once the first server stops, a server from the same folder starts on another pair", async () => {
  const port = await box.freePortPair();
  const place = box.sandbox("port-relock", { config: { port } });
  try {
    const first = box.launch(place);
    await box.waitReady(first, port);
    first.child.kill("SIGTERM");
    await once(first.child, "exit");
    let other = await box.freePortPair();
    while (Math.abs(other - port) < 2) other = await box.freePortPair();
    box.writeConfig(place.app, { port: other, lanes: [] });
    const second = box.launch(place);
    await box.waitReady(second, other);
    const held = JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8"));
    assert.deepEqual(held, { pid: second.child.pid, port: other, bridge: other + 1 });
  } finally {
    await box.cleanup(place);
  }
});
