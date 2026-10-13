// Run both pages' actual Home lifecycle without a browser. The widget tests
// exercise real cached rendering; here deferred requests expose page ordering.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = process.env.HOME_SOURCE_ROOT || path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");

function eventTarget() {
  const handlers = {};
  return {
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    fire(name) { for (const fn of handlers[name] || []) fn({ persisted: true }); },
    classList: { toggle() {}, add() {} }, setAttribute() {}, contains() { return false; },
    style: {}, textContent: "",
  };
}
function page(name) {
  const source = read(name), phone = name === "m.html";
  const start = source.indexOf('const HOME_KEY = "homeopen";');
  const end = source.indexOf(phone ? "// the heading's mark and version" : "function setHome(on){", start);
  assert.ok(start > 0 && end > start);
  const nodes = Object.fromEntries(["homeico", "homeplot", "homelimits", "stage"].map(id => [id, eventTarget()]));
  const document = eventTarget(), window = eventTarget();
  Object.assign(document, { hidden: false, getElementById: id => nodes[id], body: eventTarget() });
  const counts = { panel: 0, limits: 0, tokenLoads: 0, limitLoads: 0, tokenTicks: 0, limitTicks: 0, pauses: 0 };
  const timers = new Map();
  let timer = 0;
  const TokenWidgets = {
    panel(root) {
      counts.panel++; root.textContent = "Cached tokens";
      return { refresh() { counts.tokenLoads++; return new Promise(() => {}); }, tick() { counts.tokenTicks++; } };
    },
    limits(root) {
      counts.limits++; root.textContent = "Cached limits";
      return { refresh() { counts.limitLoads++; return new Promise(() => {}); }, tick() { counts.limitTicks++; }, pause() { counts.pauses++; } };
    },
  };
  window.TokenWidgets = TokenWidgets;
  const ctx = vm.createContext({ window, document, TokenWidgets, settingsStore: {}, homeOpen: true,
    setInterval(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source.slice(start, end), ctx);
  const run = expression => vm.runInContext(expression, ctx);
  run("homeOpen = true");
  return { source, nodes, document, window, counts, timers, run };
}

for (const name of ["index.html", "m.html"]) {
  test(`${name}: Home assets are available before page initialization`, () => {
    const html = read(name);
    assert.match(html, /<link id="homesheet" rel="stylesheet" href="\/home-widgets\.css">/);
    const widgets = html.indexOf('<script src="/home-widgets.js"></script>');
    assert.ok(widgets > 0 && widgets < html.indexOf('const HOME_KEY = "homeopen";'));
  });
  test(`${name}: cached panels appear synchronously while requests stay pending`, () => {
    const p = page(name);
    p.run("homeShow()");
    assert.equal(p.nodes.homeplot.textContent, "Cached tokens");
    assert.equal(p.nodes.homelimits.textContent, "Cached limits");
    assert.equal(p.counts.tokenLoads, 1);
    assert.equal(p.counts.limitLoads, 1);
    p.run("homeShow()");
    assert.equal(p.counts.panel, 1, "same token panel survives Home navigation");
    assert.equal(p.counts.limits, 1, "same limits panel survives Home navigation");
    assert.equal(p.timers.size, 3, "reopening does not multiply timers");
  });
  test(`${name}: warming prepares both panels and ticking keeps both times current`, () => {
    const p = page(name);
    p.run("homeOpen = false; homeWarm()");
    assert.equal(p.counts.panel, 1);
    assert.equal(p.counts.limits, 1);
    assert.equal(p.counts.tokenLoads, 1);
    assert.equal(p.counts.limitLoads, 1);
    p.run("homeOpen = true; homeShow()");
    const ticks = p.counts.tokenTicks;
    for (const t of p.timers.values()) if (t.ms === 15000) t.fn();
    assert.equal(p.counts.tokenTicks, ticks + 1);
    assert.equal(p.counts.limitTicks, p.counts.tokenTicks);
  });
  test(`${name}: online and visible wakeups recover Home without opening it elsewhere`, () => {
    const p = page(name);
    p.run("homeShow()");
    p.window.fire("online");
    assert.equal(p.counts.tokenLoads, 2);
    assert.equal(p.counts.limitLoads, 2);
    p.document.hidden = true;
    p.window.fire("online");
    assert.equal(p.counts.tokenLoads, 2, "background page stays quiet");
    assert.equal(p.counts.pauses, 1, "background page cancels pending usage follow-ups");
    p.document.hidden = false;
    p.document.fire("visibilitychange");
    p.window.fire("pageshow");
    assert.equal(p.counts.tokenLoads, 4);
    p.run("homeOpen = false");
    p.window.fire("online");
    p.document.fire("visibilitychange");
    assert.equal(p.counts.tokenLoads, 4, "other pages do not start Home polling");
  });
}

test("phone: version has reserved space and the visible brand gap exceeds the panel gap", () => {
  const html = read("m.html");
  const brand = html.match(/#homebrand\{([^}]+)\}/)[1];
  const gap = Number(html.match(/#home #homelimits\{margin-top:calc\((\d+) \* var\(--u\)\)\}/)[1]);
  const margin = Number(brand.match(/margin:calc\(-4 \* var\(--u\)\) 0 calc\((\d+) \* var\(--u\)\)/)[1]);
  const reserve = Number(brand.match(/padding-bottom:calc\((\d+) \* var\(--u\)\)/)?.[1] || 0);
  const versionHeight = 10 * 1.1; // existing 10u/1.1 version line
  assert.ok(reserve >= versionHeight, "reserve the full version line inside the centered cluster");
  assert.ok(margin + reserve - versionHeight >= 2 * gap, "visible brand gap is twice the panel gap");
  assert.match(html, /#homestack\{flex:none; margin:auto 0\}/, "all three groups remain centered together");
});
