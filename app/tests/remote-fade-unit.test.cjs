// A project on one of the owner's servers, as the pages read it: faded only
// once the board says its server's link has been down long enough (the board
// keeps the 30 seconds, remote_link.FADE_AFTER), never for a project on this
// Mac, and at once for a server the board no longer knows; its folder shown as
// the server's name and its path there; and the fade itself, the body's class
// and one line that never takes the pointer. Uses the shared logic with no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");

function page() {
  const made = [];
  const classes = new Set();
  const byId = {};
  const body = {
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: n => classes.has(n) },
    appendChild: el => { byId[el.id] = el; made.push(el); },
  };
  const document = {
    body,
    getElementById: id => byId[id] || null,
    createElement: () => ({ hidden: false, textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
  };
  const sandbox = {
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval, document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AbortSignal: { timeout: () => undefined },
    CardMarkdown: { render: text => String(text || "") },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), sandbox, { filename: "card-logic.js" });
  return { sandbox, classes, byId, made };
}

const state = servers => ({
  pwds: { far: "/home/you/far", near: "/Users/you/near" },
  projects: [{ id: "far", name: "far", dir: "/home/you/far", server: "lab" },
             { id: "near", name: "near", dir: "/Users/you/near" }],
  remote: { servers },
});

test("a server's project fades only once the board says its link has been down long enough", () => {
  const { sandbox } = page();
  assert.equal(sandbox.remoteFaded(state({ lab: { name: "lab", up: true, faded: false } }), "far"), null);
  // down, but not yet for 30 seconds: a short drop never flashes it
  assert.equal(sandbox.remoteFaded(state({ lab: { name: "lab", up: false, faded: false } }), "far"), null);
  assert.deepEqual({ ...sandbox.remoteFaded(state({ lab: { name: "Lab box", up: false, faded: true } }), "far") },
                   { server: "lab", name: "Lab box" });
  // a server the board no longer knows has no link at all
  assert.deepEqual({ ...sandbox.remoteFaded(state({}), "far") }, { server: "lab", name: "lab" });
});

test("a project on this Mac never fades, whatever a server does", () => {
  const { sandbox } = page();
  assert.equal(sandbox.remoteFaded(state({ lab: { name: "lab", up: false, faded: true } }), "near"), null);
  assert.equal(sandbox.remoteFaded(state({}), "facilitator"), null);
  assert.equal(sandbox.remoteFaded({}, "near"), null);
});

test("a server's project shows its folder as the server's name and its path", () => {
  const { sandbox } = page();
  const st = state({ lab: { name: "Lab box", up: true, faded: false } });
  assert.equal(sandbox.lanePlace(st, "far"), "Lab box:/home/you/far");
  assert.equal(sandbox.lanePlace(st, "near"), "/Users/you/near");
  assert.equal(sandbox.lanePlace(st, "nobody"), "");
});

test("a folder the picker chose is the same project only on the same machine", () => {
  const { sandbox } = page();
  const st = { ...state({ lab: { name: "lab", up: true, faded: false } }), boxes: [],
               pwds: { far: "/home/you/far", near: "/home/you/far" },
               projects: [{ id: "far", dir: "/home/you/far", server: "lab" }, { id: "near", dir: "/home/you/far" }] };
  assert.equal(sandbox.folderProject(st, { machine: "lab", path: "/home/you/far" }), "far");
  assert.equal(sandbox.folderProject(st, { machine: "this", path: "/home/you/far" }), "near");
  assert.equal(sandbox.folderProject(st, { machine: "farm", path: "/home/you/far" }), null);
  assert.equal(sandbox.folderProject(st, { machine: "this", path: "/elsewhere" }), null);
});

test("a server's folder is made a project with its machine, and refused in its own words", () => {
  const { sandbox } = page();
  assert.equal(sandbox.projectRoute({ machine: "lab", name: "my app" }), "/project?name=my%20app&machine=lab");
  assert.equal(sandbox.projectRoute({ machine: "this", name: "notes" }), "/project?name=notes");
  assert.equal(sandbox.projectRoute({ name: "" }), "/project?name=project");
  assert.equal(sandbox.folderRefusal({ error: "lab is not connected" }, {}, { machine: "lab", name: "x" }),
               "lab is not connected");
  assert.equal(sandbox.folderRefusal({ error: "body must be a folder under home" }, {}, { machine: "this", name: "x" }),
               "that folder is outside your home folder");
});

test("the fade is the body's class and one line, and it goes again when the link is back", () => {
  const { sandbox, classes, byId, made } = page();
  sandbox.showRemoteFade({ server: "lab", name: "Lab box" });
  assert.ok(classes.has("remotedown"));
  const note = byId.remotenote;
  assert.equal(note.hidden, false);
  assert.equal(note.attrs.role, "status");
  assert.match(note.textContent, /^Lab box is not connected\. What you send waits here/);
  sandbox.showRemoteFade({ server: "lab", name: "Lab box" });
  assert.equal(made.length, 1);   // one line, made once
  sandbox.showRemoteFade(null);
  assert.ok(!classes.has("remotedown"));
  assert.equal(note.hidden, true);
});

test("each page fades by the same rule and its sheet never lets the fade take the pointer", () => {
  for (const name of ["index.html", "m.html"]) {
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    assert.match(text, /showRemoteFade\(remoteFaded\(state, activeOwner\)\)/, name + " fades on every reading");
    const rule = text.match(/#remotenote\{[^}]*\}/);
    assert.ok(rule, name + " styles the line");
    assert.match(rule[0], /pointer-events:none/, name + "'s line must not take the pointer");
    assert.match(text, /body\.home #remotenote\{display:none\}/, name + " keeps the line off home");
    assert.doesNotMatch(rule[0], /--accent/, name + "'s line uses no accent");
  }
});
