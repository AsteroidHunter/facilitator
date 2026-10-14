// The Bin's rows carry a restore icon, hidden until the pointer is on the row,
// that restores on a click. Browser-free: the page's CSS is read as text and the
// row-drawing code is run with stand-ins.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const rule = sel => {
  const at = html.indexOf(sel + "{");
  assert.ok(at > 0, sel + " is not styled");
  return html.slice(at, html.indexOf("}", at));
};

test("the restore icon is hidden, then fades in over .2s on the row, in the list's grey", () => {
  const base = rule(".sp-mac .binrow .binrestore");
  assert.match(base, /opacity:0/);
  assert.match(base, /transition:opacity \.2s/);
  assert.match(base, /color:var\(--sub\)/);
  assert.doesNotMatch(base, /accent|#432BFF/i);
  assert.match(html, /\.sp-mac \.binrow:hover \.binrestore[^{]*\{opacity:1\}/);
  assert.doesNotMatch(html, /binrow \.sp-btn/, "no white button is left");
});

function drawRows() {
  const start = html.indexOf("  const binList");
  const end = html.indexOf("  const readBin", start);
  assert.ok(start > 0 && end > start);
  const el = (tag, cls, text) => ({ tag, cls, text, children: [], dataset: {}, attrs: {}, handlers: {},
    append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); },
    setAttribute(n, v) { this.attrs[n] = v; }, addEventListener(t, f) { this.handlers[t] = f; } });
  const list = el("div", "list");
  list.textContent = "";
  const fetched = [];
  const ctx = { h: el, lastState: null, labelOf: (s, o) => o, Date, poll() {}, readBin() {},
    document: { getElementById: () => list },
    fetch: (url, opt) => { fetched.push([url, opt && opt.method]); return Promise.resolve({}); } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end) + "\nthis.showBin = showBin;", ctx);
  ctx.showBin([{ id: "m7", title: "A card", owner: "x", ts: Date.now() / 1000 }]);
  return { list, fetched };
}

test("a row has an icon button titled Restore and no text button", () => {
  const { list } = drawRows();
  const btn = list.children[0].children[1];
  assert.equal(btn.cls, "binrestore");
  assert.equal(btn.title, "Restore");
  assert.equal(btn.attrs["aria-label"], "Restore");
  assert.match(btn.innerHTML, /<svg/);
  assert.equal(btn.text, undefined);
});

test("a click on the icon restores that card", async () => {
  const { list, fetched } = drawRows();
  await list.children[0].children[1].handlers.click();
  assert.deepEqual(fetched, [["/bin/restore?box=m7", "POST"]]);
});
