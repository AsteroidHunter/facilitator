// The board's folder picker (folder-picker.js) with one of the owner's servers
// beside this Mac, without a page: a server under Machines opens at its home,
// listed there through /dirs with its machine named; a folder chosen on it
// names that machine; a new folder is made there; the listings kept for this
// Mac are not used for the server's columns; an offline server is not asked;
// and a server that cannot be listed leaves the picker where it was.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const FP = require(path.join(path.resolve(__dirname, ".."), "folder-picker.js"));

const MAC = "/Users/robin", LAB = "/home/robin";
const TREES = {
  this: { [MAC]: ["notes"], [MAC + "/notes"]: [] },
  lab: { [LAB]: ["jobs", "notes"], [LAB + "/jobs"]: ["nightly"], [LAB + "/jobs/nightly"]: [], [LAB + "/notes"]: [] },
};
const MACHINES = [
  { id: "this", name: "This Mac", kind: "computer", online: true, top: MAC, home: MAC, sep: "/",
    places: [{ id: "home", name: "robin", path: MAC }] },
  { id: "lab", name: "lab", kind: "server", online: true, top: LAB, home: LAB, sep: "/",
    places: [{ id: "home", name: "robin", path: LAB }] },
  { id: "farm", name: "farm", kind: "server", online: false, top: "/home/robin", home: "/home/robin", sep: "/",
    places: [{ id: "home", name: "robin", path: "/home/robin" }] },
];

function server({ labDown = false } = {}){
  const asked = [];
  const listing = (machine, p) => {
    const top = machine === "lab" ? LAB : MAC;
    const rel = p === top ? [] : p.slice(top.length + 1).split("/");
    const trail = [{ name: "robin", path: top }];
    rel.forEach((n, i) => trail.push({ name: n, path: top + "/" + rel.slice(0, i + 1).join("/") }));
    return { machine, path: p, name: p === top ? "robin" : rel.at(-1), short: p === top ? "~" : "~/" + rel.join("/"),
      top, parent: p === top ? null : p.slice(0, p.lastIndexOf("/")), trail, more: 0, unreadable: false,
      dirs: TREES[machine][p].slice().sort().map(n => ({ name: n, path: p + "/" + n, modified: 0, items: TREES[machine][p + "/" + n].length })) };
  };
  async function ask(url, init){
    asked.push((init && init.method === "POST" ? "POST " : "") + url);
    const u = new URL(url, "http://board");
    const machine = u.searchParams.get("machine") || "this";
    if (u.pathname === "/machines") return { ok: true, status: 200, json: { machines: MACHINES } };
    if (u.pathname === "/dirs"){
      if (machine === "lab" && labDown) return { ok: false, status: 400, json: { error: "lab is not connected" } };
      const p = u.searchParams.get("path") || (machine === "lab" ? LAB : MAC);
      if (!(p in TREES[machine])) return { ok: false, status: 400, json: { error: "no folder there" } };
      return { ok: true, status: 200, json: listing(machine, p) };
    }
    if (u.pathname === "/mkdir"){
      const p = u.searchParams.get("path"), n = u.searchParams.get("name");
      TREES[machine][p].push(n); TREES[machine][p + "/" + n] = [];
      return { ok: true, status: 200, json: { ok: true, name: n, path: p + "/" + n } };
    }
    throw new Error("unexpected " + url);
  }
  return { ask, asked };
}
const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
async function picker(opts = {}, over = {}){
  const s = server(over);
  const p = new FP.Picker(opts, { ask: s.ask, store: store(), now: () => 0 });
  await p.start();
  return { p, s };
}
const names = p => p.rows().map(r => r.name);

test("a server under Machines opens at its home, listed there", async () => {
  const { p, s } = await picker();
  assert.equal(p.machineId, "this");
  await p.choosePlace("lab");
  assert.equal(p.machineId, "lab");
  assert.equal(p.place, "lab");
  assert.equal(p.at.path, LAB);
  assert.deepEqual(names(p), ["jobs", "notes"]);
  assert.equal(s.asked.at(-1), "/dirs?path=%2Fhome%2Frobin&machine=lab");
  await p.go(LAB + "/jobs");
  assert.equal(s.asked.at(-1), "/dirs?path=%2Fhome%2Frobin%2Fjobs&machine=lab");
  // and back to this Mac
  await p.choosePlace("this");
  assert.equal(p.machineId, "this");
  assert.equal(p.at.path, MAC);
  assert.equal(s.asked.at(-1), "/dirs?path=%2FUsers%2Frobin");
});

test("a folder chosen on a server names that machine", async () => {
  let given = null;
  const { p } = await picker({ choose: async folder => { given = folder; return null; } });
  await p.choosePlace("lab");
  await p.go(LAB + "/jobs/nightly");
  const folder = await p.choose();
  assert.deepEqual(folder, { machine: "lab", path: LAB + "/jobs/nightly", name: "nightly", short: "~/jobs/nightly" });
  assert.deepEqual(given, folder);
});

test("a new folder on a server is made there", async () => {
  const { p, s } = await picker();
  await p.choosePlace("lab");
  p.newFolder();
  await p.nameFolder("made");
  assert.ok(s.asked.includes("POST /mkdir?path=%2Fhome%2Frobin&name=made&machine=lab"));
  assert.deepEqual(names(p), ["jobs", "made", "notes"]);
});

test("this Mac's listings are not used for a server's columns", async () => {
  const { p } = await picker({ kind: "panel" });
  await p.setView("columns");
  await p.go(MAC + "/notes");
  await p.choosePlace("lab");
  await p.go(LAB + "/notes");
  for (const column of p.columns()) assert.ok(column.listing === null || column.listing.machine === "lab", column.path);
  assert.ok(p.columns().every(c => c.path.startsWith(LAB)));
});

test("an offline server is not asked, and the picker stays where it was", async () => {
  const { p, s } = await picker();
  const before = s.asked.length;
  assert.equal(await p.choosePlace("farm"), false);
  assert.equal(s.asked.length, before);
  assert.equal(p.machineId, "this");
  assert.equal(p.note, "farm is offline");
});

test("a server that cannot be listed leaves the picker on this Mac and says why", async () => {
  const { p } = await picker({}, { labDown: true });
  await p.go(MAC + "/notes");
  assert.equal(await p.choosePlace("lab"), false);
  assert.equal(p.machineId, "this");
  assert.equal(p.at.path, MAC + "/notes");
  assert.equal(p.note, "Lab is not connected");
});
