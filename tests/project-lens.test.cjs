// Run the real desktop lens and drag handlers with synthetic geometry/clock.
// These verify behavior and sampling math, not browser rendering or smoothness.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { fixture, html, between } = require("./project-lens-fixture.cjs");

test("shared glass tokens preserve the established Mac material and tuning", () => {
  const tokens = readFileSync(path.join(__dirname, "..", "card-tokens.css"), "utf8");
  const block = (source, selector) => {
    const start = source.indexOf(selector + "{");
    assert.ok(start >= 0, selector);
    return source.slice(start + selector.length + 1, source.indexOf("}", start)).replace(/\/\*[^]*?\*\//g, "");
  };
  const value = (source, property) => {
    const match = source.match(new RegExp(`(?:^|;)\\s*${property}:([^;]+)`));
    assert.ok(match, property);
    return match[1].replace(/\s+/g, " ").trim();
  };
  const shared = block(tokens, ".qn-glass"), face = block(tokens.slice(tokens.indexOf(".qn-glass{") + 1), ".qn-glass");
  const player = block(html, "\n  #magic1.filled");
  const resolve = (text, overrides) => text.replace(/var\((--qn-[\w-]+)\)/g,
    (_, name) => resolve(overrides[name] ?? value(shared, name), overrides));
  // The original material is still written out on the player at edge strength
  // one. Compare every layer, in order, instead of trusting the new token names.
  for (const property of ["background-image", "box-shadow"]) {
    const actual = resolve(value(face, property), { "--qn-edge": "1" }).replace(/calc\(([\d.]+) \* 1\)/g, "$1");
    assert.equal(actual, value(player, property), property);
  }
  assert.equal(value(face, "border-radius"), value(player, "border-radius"));
  assert.equal(resolve(value(face, "background-color"), {}), "rgba(255,255,255,.77)");
  assert.equal(resolve(value(face, "background-color"), { "--qn-tint": ".95" }), "rgba(255,255,255,.95)");
  for (const edge of ["2", "3", "3.5"]) {
    const light = resolve(value(face, "background-image"), { "--qn-edge": edge });
    assert.ok(light.includes(`calc(.60 * ${edge})`), "press lighting must resolve locally");
  }
  for (const property of ["backdrop-filter", "-webkit-backdrop-filter"])
    assert.equal(resolve(value(face, property), {}), "blur(15px) saturate(180%)");
});

test("hidden cross drags only the lens, keeps all names and workspace still, selects once on release", () => {
  const f = fixture(); f.down(); f.move(180); f.move(300);
  assert.equal(f.context.tabDrag.mode, "select");
  assert.equal(f.context.activeOwner, "a"); assert.deepEqual(f.switches, []); assert.deepEqual(f.writes, []);
  assert.ok(Object.values(f.tabs).every(t => !t.style.transform));
  assert.notEqual(f.seat.el.style.transform, "translateX(40px)");
  f.up(300, 22, f.tabs.c); f.click("c");
  assert.deepEqual(f.switches, ["c"]); assert.deepEqual(f.writes, []);
  assert.equal(f.seat.owner, "c"); f.tick(0); assert.equal(f.context.tabDrag, null);
});

test("press before the hover timer fires stays a selection drag, even if held past the dwell", () => {
  const f = fixture(); f.context.tabDwell(f.tabs.a); f.tick(1600); f.down(); f.tick(500);
  assert.equal(f.tabs.a.classList.contains("armed"), false);
  f.tabs.a.classList.add("armed"); // even a late external change cannot change the captured intent
  f.move(180); assert.equal(f.context.tabDrag.mode, "select");
});

test("visible cross latches reorder even after the cross disappears, and writes order without selecting", () => {
  const f = fixture(); f.context.tabDwell(f.tabs.a); f.tick(1700);
  assert.equal(f.tabs.a.classList.contains("armed"), true);
  f.down(); f.context.disarmTab(); f.move(350); f.up(350); f.click("a");
  assert.deepEqual(f.writes[0].order, ["b", "c", "a"]); assert.deepEqual(f.switches, []);
  f.tick(250); assert.equal(f.context.tabDrag, null); assert.equal(f.context.tabGlide, null);
  assert.ok(Object.values(f.tabs).every(t => !t.style.transform));
});

test("a nonselected armed project has an independent held lens which is removed after reorder", () => {
  const f = fixture(); f.tabs.b.classList.add("armed"); f.down("b"); f.move(45);
  const held = f.context.tabDrag.held;
  assert.ok(held.lens.filter); assert.notEqual(held.lens.filter, f.seat.face.lens.filter);
  f.up(45); f.tick(250);
  assert.equal(held.isConnected, false); assert.equal(held.lens.filter.isConnected, false);
  assert.equal(f.context.activeOwner, "a"); assert.deepEqual(f.writes[0].order, ["b", "a", "c"]);
});

test("reorder keeps closed projects in the stored order and out of measured slots", () => {
  const f = fixture({ closed: ["b"] }); f.tabs.a.classList.add("armed"); f.down(); f.move(215); f.up(215);
  assert.deepEqual(f.writes[0], { order: ["b", "c", "a"], closed: ["b"] });
});

test("a drag that releases outside the names cancels and returns the lens", () => {
  const f = fixture(); f.down(); f.move(200); f.up(200, 80); f.click("a");
  assert.deepEqual(f.switches, []); assert.equal(f.seat.el.style.transform, "translateX(40px)");
});

test("Escape, blur, pointer cancel and hidden-page cancellation never select on later release/click", () => {
  for (const type of ["keydown", "blur", "pointercancel", "visibilitychange"]) {
    const f = fixture(); f.down(); f.move(300);
    if (type === "visibilitychange") f.document.visibilityState = "hidden";
    let stopped = false;
    f.dispatch(type, { key: "Escape", preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    f.up(300); f.click("c");
    assert.deepEqual(f.switches, [], type); assert.equal(f.seat.el.style.transform, "translateX(40px)", type);
    if (type === "keydown") assert.equal(stopped, true);
  }
});

test("a release outside the window cancels selection on the next button-free move", () => {
  const f = fixture(); f.down(); f.move(300); f.move(300, 22, 0);
  assert.deepEqual(f.switches, []); assert.equal(f.context.tabDrag, null);
});

test("removed or remotely closed release targets are not selected", () => {
  for (const kind of ["removed", "closed"]) {
    const f = fixture(); f.down(); f.move(300);
    if (kind === "removed") f.context.validActiveOwnerIds.delete("c"); else f.context.lastState.closed.push("c");
    f.up(300); assert.deepEqual(f.switches, [], kind);
  }
});

test("small movement stays a normal click, and a new dwell starts after release", () => {
  const f = fixture(); const start = f.down("b"); f.tabs.b.hovered = true;
  f.move(start.clientX + 3); f.up(start.clientX + 3, 22, f.tabs.b); f.click("b"); f.tick(0); f.tick(1700);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.tabs.b.classList.contains("armed"), true);
});

test("a right-button press cannot start a drag", () => {
  const f = fixture(); f.down("a", { button: 2 }); assert.equal(f.context.tabDrag, null);
});

test("vertical tear-out still opens once, and a locked horizontal gesture cannot turn into tear-out", () => {
  const f = fixture(); f.down(); f.move(90, 70); f.up(90, 70); f.click("a");
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0][0], "/?project=a"); assert.deepEqual(f.switches, []);
  const s = fixture(); s.down(); s.move(150); s.move(200, 90); s.up(200, 90);
  assert.deepEqual(s.opens, []); assert.deepEqual(s.switches, []);
});

test("selection can begin on home; cancelling returns to its circle, releasing selects once", () => {
  const f = fixture({ home: true }); assert.equal(f.seat.el.classList.contains("gone"), false); assert.equal(f.seat.w, 32);
  f.down(); f.move(180); assert.equal(f.context.homeOpen, true); assert.equal(f.seat.el.classList.contains("gone"), false);
  f.up(180, 80); assert.equal(f.seat.el.classList.contains("gone"), false); assert.equal(f.seat.returning, false); assert.equal(f.seat.w, 32); assert.equal(f.seat.x, 0);
  f.tick(0); f.down(); f.move(180); f.up(180);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.context.homeOpen, false);
});

test("the lens dragged onto the house previews Home's circle and opens Home on release", () => {
  const f = fixture(); f.down(); f.move(180);
  assert.equal(f.seat.el.style.width, "100px");
  f.move(16);
  assert.equal(f.seat.el.style.width, "32px"); assert.equal(f.seat.el.style.transform, "translateX(0px)");
  assert.equal(f.context.homeOpen, false, "Home opened before the release");
  assert.deepEqual(f.switches, []); assert.deepEqual(f.writes, []);
  assert.equal(f.seat.el.classList.contains("round"), true, "the lens over the house is not the house's circle");
  f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true); assert.equal(f.seat.owner, f.get("HOME_SEAT"));
  assert.equal(f.seat.w, 32); assert.equal(f.seat.x, 0);
  assert.equal(f.seat.el.classList.contains("round"), true, "Home opened with a lens that is not its circle");
  assert.deepEqual(f.switches, []); assert.equal(f.context.activeOwner, "a");
  f.tick(0); assert.equal(f.context.tabDrag, null);
});

test("moving off the house shows the name lens again, and a release on a name selects it", () => {
  const f = fixture(), round = () => f.seat.el.classList.contains("round");
  f.down(); assert.equal(round(), false); f.move(16);
  assert.equal(f.seat.el.style.width, "32px"); assert.equal(round(), true, "the circle comes with the width");
  f.move(200);
  assert.equal(f.seat.el.style.width, "100px"); assert.equal(f.seat.el.style.transform, "translateX(150px)");
  assert.equal(round(), false, "the name's corners come back with its width");
  f.move(36);   // the gap between the house and the first name is neither
  assert.equal(f.seat.el.style.width, "100px"); assert.equal(f.seat.el.style.transform, "translateX(40px)");
  assert.equal(round(), false);
  f.move(16); assert.equal(round(), true); f.move(200); f.up(200, 22, f.tabs.b);
  assert.equal(f.context.homeOpen, false); assert.deepEqual(f.switches, ["b"]);
  assert.equal(round(), false, "a lens set down on a name is still the house's circle");
});

test("cancelling a drag that is over the house restores the name lens and opens nothing", () => {
  for (const type of ["keydown", "blur", "pointercancel", "visibilitychange"]) {
    const f = fixture(); f.down(); f.move(16);
    if (type === "visibilitychange") f.document.visibilityState = "hidden";
    f.dispatch(type, { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(f.seat.el.style.width, "100px", type); assert.equal(f.seat.el.style.transform, "translateX(40px)", type);
    assert.equal(f.seat.el.classList.contains("round"), false, type + ": the name's lens is still the house's circle");
    f.up(16, 22, f.homeButton);
    assert.equal(f.context.homeOpen, false, type); assert.deepEqual(f.switches, [], type);
  }
  const out = fixture(); out.down(); out.move(16); out.up(16, 80, out.homeButton);   // released below the row
  assert.equal(out.context.homeOpen, false); assert.equal(out.seat.el.style.transform, "translateX(40px)");
  assert.equal(out.seat.el.classList.contains("round"), false);
  const gone = fixture(); gone.down(); gone.move(16); gone.move(16, 22, 0);   // released outside the window
  assert.equal(gone.context.homeOpen, false); assert.equal(gone.seat.el.style.transform, "translateX(40px)");
  assert.equal(gone.seat.el.classList.contains("round"), false);
});

test("a drag from Home can be carried back onto the house, which stays open, or onto a name", () => {
  const f = fixture({ home: true }), round = () => f.seat.el.classList.contains("round");
  assert.equal(round(), true, "Home's lens is its circle");
  f.down("b"); f.move(200);
  assert.equal(round(), false, "a name carried from Home is a name's lens, not the house's circle");
  f.move(16);
  assert.equal(f.seat.el.style.width, "32px"); assert.equal(round(), true); f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true); assert.deepEqual(f.switches, []); assert.equal(f.seat.x, 0);
  assert.equal(round(), true);
  f.tick(0); f.down("b"); f.move(16); f.move(200); f.up(200, 22, f.tabs.b);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.context.homeOpen, false);
  assert.equal(round(), false);
  // let go off the house and the names while Home is open: the lens goes back to Home as its circle
  const g = fixture({ home: true }); g.down("b"); g.move(200); g.up(200, 80, g.homeButton);
  assert.equal(g.context.homeOpen, true); assert.equal(g.seat.el.classList.contains("round"), true);
  assert.equal(g.seat.el.classList.contains("still"), false, "the way back to Home slides, and turns as it slides");
});

test("a reorder drag never lands on the house and only reorders the projects", () => {
  const f = fixture(); f.tabs.b.classList.add("armed"); f.down("b"); f.move(10); f.move(16);
  assert.equal(f.context.tabDrag.mode, "reorder"); assert.equal(f.seat.el.style.width, "100px");
  f.up(16, 22, f.homeButton); f.tick(250);
  assert.equal(f.context.homeOpen, false); assert.deepEqual(f.switches, []);
  assert.deepEqual(f.writes[0].order, ["b", "a", "c"]);
});

test("a close button stops the tab gesture and closes only that project; the final tab stays", () => {
  const f = fixture(); const button = f.context.tabKillMark("b"); let stopped = 0;
  const e = { preventDefault() {}, stopPropagation() { stopped++; } };
  button.listeners.mousedown[0](e); button.listeners.pointerdown[0](e); button.listeners.click[0](e);
  assert.equal(stopped, 3); assert.equal(f.context.tabDrag, null); assert.deepEqual(f.writes[0].closed, ["b"]);
  f.context.closeTab("c"); f.context.closeTab("a"); assert.deepEqual([...f.context.lastState.closed], ["b", "c"]);
});

test("the lens follows a close before the selected name and keeps the label's full 32px height", () => {
  const f = fixture(); f.context.setTab("c"); f.context.placeSeat(); assert.equal(f.seat.x, 280);
  f.context.closeTab("b"); f.context.placeSeat(); assert.equal(f.seat.x, 140);
  assert.equal(f.seat.el.getBoundingClientRect().height, 32);
  f.context.placeSeat(); assert.equal(f.seat.el.classList.contains("still"), true);
});

test("center sampling enlarges by 1.075 and the rim adds inward curved displacement", () => {
  const f = fixture(), offset = f.context.lensOffset;
  const x = 75, dx = offset(x, 16, 100)[0];
  assert.ok(Math.abs((x + dx - 50) - (x - 50) / 1.075) < 1e-9);
  assert.deepEqual([...offset(50, 16, 100)], [0, 0]);
  assert.ok(offset(50, 1.25, 100)[1] > (16 - 1.25) * (1 - 1 / 1.075) + .46);
  assert.ok(offset(1.25, 16, 100)[0] > (50 - 1.25) * (1 - 1 / 1.075) + .46);
});

test("sampling remains inside the captured rectangle for short, long and fractional pills", () => {
  const f = fixture();
  for (const width of [28, 32, 79.5, 143, 480, 1200]) for (let y = .5; y < 32; y++) for (let x = .5; x < width; x += 1.5) {
    const [dx, dy] = f.context.lensOffset(x, y, width);
    assert.ok(x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < 32, `${width}: ${x},${y}`);
  }
});

test("encoded zoom and rim maps have exact neutral centers and bounded quantization error", () => {
  const f = fixture(), map = f.context.lensMap(143), [zoom, rim] = f.images;
  assert.equal(f.context.lensMap(143), map); assert.equal(f.images.length, 2);
  const k = 1 - 1 / 1.075, decode = byte => (byte - 128) / 254;
  for (let y = 0; y < 32; y += 3) for (let x = 0; x < 143; x += 7) {
    const expected = f.context.lensOffset(x + .5, y + .5, 143), i = (y * 143 + x) * 4;
    for (let axis = 0; axis < 2; axis++) {
      const actual = map.span * k * decode(zoom.data[i + axis]) + 2 / 1.075 * decode(rim.data[i + axis]);
      assert.ok(Math.abs(actual - expected[axis]) <= (map.span * k + 2 / 1.075) / 508 + 1e-9);
    }
    assert.equal(rim.data[i + 3], 255);
    if (f.context.lensDepth(x + .5, y + .5, 143) >= 2.5) {
      assert.equal(rim.data[i], 128); assert.equal(rim.data[i + 1], 128);
    }
  }
  for (let width = 200; width < 280; width++) f.context.lensMap(width);
  assert.equal(f.get("lensMaps.size"), 64);
});

test("lens resizing updates local map dimensions; translation alone needs no regenerated map", () => {
  const f = fixture(), el = f.seat.face;
  f.context.resizeLens(el, 100); const first = el.lens.map;
  f.down(); f.move(170); assert.equal(el.lens.map, first); assert.equal(f.images.length, 2);
  f.context.resizeLens(el, 140.25);
  assert.equal(el.lens.images[0].attributes.width, "140.25"); assert.notEqual(el.lens.map, first);
  assert.equal(el.attributes["aria-hidden"], "true");
});

test("the native rim mapping is monotonic through the old fold and smooth at both ends", () => {
  const f = fixture(), sample = (y, zoom) => y + f.context.lensOffset(50, y, 100, 32, zoom)[1];
  for (const zoom of [1.075, 1.075 * 1.04, 1.075 * 1.1]) {
    let previous = sample(0, zoom);
    for (let y = .01; y < 16; y += .01) {
      const next = sample(y, zoom); assert.ok(next > previous, `fold at ${y}, zoom ${zoom}`); previous = next;
    }
    const e = 1e-5, slope = y => (sample(y + e, zoom) - sample(y - e, zoom)) / (2 * e);
    for (const join of [0, 2.5, 3.5, 6]) assert.ok(Math.abs(slope(join) - 1 / zoom) < .0001, `kink at ${join}`);
  }
});

test("the inner mask completely replaces original ink and feathers only after the nonlinear rim ends", () => {
  const f = fixture(), alpha = f.context.lensCenterAlpha;
  assert.equal(alpha(-1), 0); assert.equal(alpha(2.5), 0); assert.equal(alpha(3.5), 1); assert.equal(alpha(16), 1);
  assert.ok(alpha(3) > 0 && alpha(3) < 1);
  const e = 1e-6;
  for (const join of [2.5, 3.5]) assert.ok(Math.abs((alpha(join + e) - alpha(join - e)) / (2 * e)) < .00001);
  f.context.devicePixelRatio = 2; f.context.lensMap(87.375);
  const map = f.images[0]; assert.equal(map.width, 175); assert.equal(map.height, 64);
  // the box's mask: four corners, a radial gradient each about the corner's
  // centre, and two straight bands. read back from the CSS it is, layer by layer
  const topLevel = text => { const out = []; let depth = 0, from = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++; else if (text[i] === ")") depth--;
      else if (text[i] === "," && !depth) { out.push(text.slice(from, i)); from = i + 1; }
    }
    return out.concat(text.slice(from)); };
  // a size or place in px, "0", "100%" or "calc(100% - Npx)" of the whole
  const length = (token, whole) => token === "0" ? 0 : token === "100%" ? whole :
    token.startsWith("calc(") ? whole - parseFloat(token.match(/- ([\d.]+)px/)[1]) : parseFloat(token);
  const layer = (text, width) => {
    const m = text.match(/^(radial|linear)-gradient\((.*)\) (.+?)\/(.+?) no-repeat$/), H = 32;
    assert.ok(m, text);
    const [head, ...colors] = topLevel(m[2]).map(s => s.trim());
    const size = m[4].split(/ (?![^(]*\))/), place = m[3].split(" ");
    const wide = length(size[0], width), high = length(size[1], H);
    const x0 = place[0] === "left" ? 0 : place[0] === "right" ? width - wide : length(place[0], width);
    const y0 = place[1] === "top" ? 0 : place[1] === "bottom" ? H - high : length(place[1], H);
    // each stop: its alpha, and its place along the gradient, from the start in px or from the far end
    const stops = colors.map(s => {
      const k = s.match(/^rgba\(0,0,0,([\d.]+)\) (.+)$/), back = k[2].match(/^calc\(100% - ([\d.]+)px\)$/);
      return { alpha: Number(k[1]), at: back ? null : parseFloat(k[2]), back: back ? parseFloat(back[1]) : null };
    });
    const radial = m[1] === "radial", along = radial ? null : head === "to right" ? "x" : "y";
    return { radial, x0, y0, wide, high, stops, along, centre: radial ? head.match(/at ([\d.]+)px ([\d.]+)px/).slice(1).map(Number) : null };
  };
  const coverAt = (l, x, y) => {
    if (x < l.x0 || x >= l.x0 + l.wide || y < l.y0 || y >= l.y0 + l.high) return 0;
    const where = l.radial ? Math.hypot(x - l.x0 - l.centre[0], y - l.y0 - l.centre[1]) : l.along === "x" ? x - l.x0 : y - l.y0;
    const span = l.along === "x" ? l.wide : l.high;
    const stops = l.stops.map(s => [s.at !== null ? s.at : span - s.back, s.alpha]);
    if (where <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) if (where <= stops[i][0]) {
      const [a, va] = stops[i - 1], [b, vb] = stops[i]; return va + (vb - va) * (where - a) / (b - a);
    }
    return stops.at(-1)[1];
  };
  // a name's 7px, the house's circle (16 on its 32px) and a corner part way
  // between, which a lens wears while it turns from one to the other
  for (const corner of [7, 16, 10.3]) for (const width of [28, 32, 87.375, 480]) {
    const css = f.context.lensCenterMask(width, corner);
    assert.doesNotMatch(css, /url\(/, "an undecoded mask image could expose the broken center for a frame");
    const layers = topLevel(css).map(text => layer(text.trim(), width));
    assert.equal(layers.length, 6, "four corners and two bands");
    assert.equal(layers.filter(l => l.radial).length, 4);
    for (let y = .125; y < 32; y += .5) for (let x = .125; x < width; x += .5) {
      const coverage = 1 - layers.reduce((left, l) => left * (1 - coverAt(l, x, y)), 1), depth = f.context.lensDepth(x, y, width, 32, corner);
      if (depth >= 3.5) assert.equal(coverage, 1, `original center pixels can leak through at ${x},${y} of ${width}, corner ${corner}`);
      if (depth <= 2.5) assert.equal(coverage, 0, `the clear copy conceals the actual optical rim at ${x},${y} of ${width}, corner ${corner}`);
    }
  }
});

function assertCopyPosition(f, source, face = f.seat.face) {
  const copy = face.lens.copies.get(source); assert.ok(copy, "source has no visual copy");
  const numbers = copy.style.transform.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi).map(Number);
  const [x, y, scaleX, scaleY] = numbers;
  const r = face.getBoundingClientRect(), s = source.getBoundingClientRect();
  const width = parseFloat(face.style.width || face.parentNode.style.width), px = r.width / width, py = r.height / 32;
  const zoom = 1.075 * py, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  assert.ok(Math.abs((r.left + x * px) - (cx + (s.left - cx) * zoom)) < 1e-8, "horizontal copy drift");
  assert.ok(Math.abs((r.top + y * py) - (cy + (s.top - cy) * zoom)) < 1e-8, "vertical copy drift");
  assert.ok(Math.abs(scaleX * px - zoom) < 1e-8); assert.ok(Math.abs(scaleY * py - zoom) < 1e-8);
  return copy;
}

test("the center uses plain inert text, with the existing glass classes and no copied controls or IDs", () => {
  const f = fixture({ render: true }), face = f.seat.face, clear = face.lens.clear;
  assert.equal(face.classList.contains("qn-glass"), true, "the shared glass material was replaced");
  assert.equal(clear.classList.contains("qn-glass"), true);
  assert.equal(clear.inert, true); assert.equal(clear.attributes["aria-hidden"], "true");
  assert.equal(face.lens.copies.size, 4);
  for (const source of Object.values(f.tabs).map(t => t.querySelector(".plabel"))) {
    const copy = assertCopyPosition(f, source);
    assert.equal(copy.tagName, "span"); assert.equal(copy.textContent, source.textContent);
    assert.deepEqual(copy.listeners, {}); assert.equal(copy.attributes.id, undefined); assert.equal(copy.dataset.owner, undefined);
    assert.equal(copy.style.filter, undefined);
  }
  const css = between("  body.focus #tabrow .projectlens{", "  /* The outer seat moves");
  const surface = css.slice(0, css.indexOf("}"));
  assert.doesNotMatch(surface, /background:|box-shadow:/, "a bespoke material overrides the shared control recipe");
  assert.match(css, /background-image:inherit; box-shadow:inherit/);
  assert.match(css, /background-color:color-mix\(in srgb, var\(--paper\), #fff calc\(var\(--qn-tint\) \* 100%\)\)/);
  assert.match(css, /backdrop-filter:none/);
});

test("copy geometry tracks fractional slide/width and press states, with no new PNGs for pressing", () => {
  const f = fixture({ render: true }), label = f.tabs.b.querySelector(".plabel");
  for (const width of [100, 112.375, 139.75]) {
    f.seat.el.style.width = width + "px"; f.seat.el.style.transform = "translateX(47.625px)";
    f.context.paintLenses(); const images = f.images.length;
    for (const press of [1, 1.025, 1.075, 1.1, 1.03, 1]) {
      f.seat.face.pressScale = press; f.context.paintLenses(); assertCopyPosition(f, label);
      assert.equal(f.images.length, images, "press regenerated a geometry map");
      const expected = Math.max(width, 32) * (1 - 1 / (1.075 * press));
      assert.ok(Math.abs(Number(f.seat.face.lens.zoom.attributes.scale) - expected) < 1e-9);
    }
  }
});

test("renames, unread weights, closed/draft names and close-band opacity synchronize without stale copies", () => {
  const f = fixture({ render: true }), label = f.tabs.a.querySelector(".plabel"), face = f.seat.face;
  const before = face.lens.copies.get(label);
  label.textContent = "A renamed project"; f.tabs.a.classList.add("unread", "armed"); f.context.paintLenses();
  assert.equal(face.lens.copies.get(label), before); assert.equal(before.textContent, "A renamed project");
  assert.equal(before.style.fontWeight, "600");
  const cross = f.tabs.a.querySelector(".ptabx"); assertCopyPosition(f, cross);
  assert.equal(face.lens.copies.get(cross).classList.contains("lenscross"), true);
  cross.classes.add("off"); f.context.paintLenses(); assert.equal(face.lens.copies.get(cross).style.opacity, "0.3");
  f.tabs.a.classes.delete("armed"); f.context.paintLenses(); assert.equal(face.lens.copies.has(cross), false);
  f.tabs.b.classes.add("closed"); f.tabs.c.classes.add("draft"); f.tabs.c.querySelector(".plabel").textContent = "New Project";
  f.context.paintLenses(); assert.equal(face.lens.copies.has(f.tabs.b.querySelector(".plabel")), false);
  assert.equal(face.lens.copies.get(f.tabs.c.querySelector(".plabel")).textContent, "New Project");
});

test("both the selected and temporary lens follow translated/reordered label positions", () => {
  const f = fixture({ render: true }); f.tabs.b.classes.add("armed"); f.down("b"); f.move(45);
  const held = f.context.tabDrag.held; f.context.paintLenses();
  for (const source of Object.values(f.tabs).map(t => t.querySelector(".plabel"))) {
    assertCopyPosition(f, source); assertCopyPosition(f, source, held);
  }
  f.up(45); f.tick(250); f.context.paintLenses();
  assert.equal(f.get("liveLenses.size"), 1); assert.equal(held.isConnected, false);
});

test("rendering work stops at rest, ignores its own copy mutations and follows active CSS motion", () => {
  const f = fixture({ render: true }); assert.equal(f.frames.size, 0);
  const copy = [...f.seat.face.lens.copies.values()][0];
  f.observers[0].fn([{ target: copy }]); assert.equal(f.frames.size, 0, "copy mutations caused an endless paint loop");
  f.observers[0].fn([{ target: f.tabs.a.querySelector(".plabel") }]); assert.equal(f.frames.size, 1);
  f.row.animations = [{ playState: "running" }]; f.tick(16); assert.equal(f.frames.size, 1);
  f.row.animations = []; f.tick(16); assert.equal(f.frames.size, 0);
  f.row.listeners.pointerover[0](); assert.equal(f.frames.size, 1); f.tick(16); assert.equal(f.frames.size, 0);
  f.document.visibilityState = "hidden"; f.context.queueLensPaint(); f.tick(16); assert.equal(f.frames.size, 0);
});

test("Home and projects use the same lens, with a 32px circle at Home and a capsule on return", () => {
  const f = fixture({ render:true }), element = f.seat.el, face = f.seat.face;
  assert.equal(element.parentNode, f.row); assert.equal(f.seat.x, 40);
  f.homeButton.listeners.click[0](); f.context.paintLenses();
  assert.equal(f.context.homeOpen, true); assert.equal(f.seat.owner, f.get("HOME_SEAT"));
  assert.equal(f.seat.x, 0); assert.equal(f.seat.w, 32);
  assert.equal(face.getBoundingClientRect().width, 32); assert.equal(face.getBoundingClientRect().height, 32);
  // the 32px lens on the house is a circle, its maps and mask cut for a 16px corner
  assert.equal(f.seat.el.classList.contains("round"), true, "the lens on Home is not the house's circle");
  assert.equal(f.get("getComputedStyle(tabSeat.face).borderTopLeftRadius"), "16px");
  assert.equal(face.lens.map, f.context.lensMap(32, 16)); assert.equal(face.lens.mask, f.context.lensCenterMask(32, 16));
  assert.equal(f.seat.el.classList.contains("still"), true, "Home did not get the same set-down as a project name");
  assert.equal(f.seat.el.classList.contains("gone"), false);
  f.context.placeSeat(); assert.equal(f.seat.el, element); assert.equal(f.seat.face, face);
  f.click("b"); f.context.placeSeat(); f.context.paintLenses();
  assert.equal(f.context.homeOpen, false); assert.equal(f.seat.owner, "b");
  assert.equal(f.seat.w, 140); assert.equal(f.seat.x, 140);
  assert.equal(f.seat.el, element); assert.equal(f.seat.face, face); assert.equal(f.get("liveLenses.size"), 1);
  // and back on a name it is the name's 7px box again, in the same frame
  assert.equal(f.seat.el.classList.contains("round"), false);
  assert.equal(f.get("getComputedStyle(tabSeat.face).borderTopLeftRadius"), "7px");
  assert.equal(face.lens.map, f.context.lensMap(140, 7)); assert.equal(face.lens.mask, f.context.lensCenterMask(140, 7));
  assertCopyPosition(f, f.house);
  assert.equal(f.homeButton.listeners.mousedown, undefined, "Home gained a project drag/reorder gesture");
});

test("the Home center mirrors its existing SVG as an inert vector without IDs or handlers", () => {
  const f = fixture({ home:true, render:true }), source = f.house;
  const copy = assertCopyPosition(f, source), icon = copy.firstElementChild;
  assert.equal(icon.tagName, "svg"); assert.notEqual(icon, source);
  assert.equal(icon.attributes.width, "15"); assert.equal(icon.attributes.height, "15");
  assert.equal(icon.attributes.viewBox, source.attributes.viewBox);
  assert.deepEqual(icon.children.map(p => p.attributes.d), source.children.map(p => p.attributes.d));
  assert.equal(icon.attributes["aria-hidden"], "true"); assert.equal(icon.attributes.focusable, "false");
  assert.deepEqual(icon.listeners, {}); assert.equal(f.seat.face.lens.clear.inert, true);
  source.setAttribute("id", "source-only"); source.setAttribute("onclick", "source handler");
  source.children[0].setAttribute("id", "source-path"); source.children[0].setAttribute("tabindex", "0");
  const clean = f.context.lensIconCopy(source);
  for (const node of [clean, ...clean.querySelectorAll("*")]) {
    assert.equal(node.attributes.id, undefined); assert.equal(node.attributes.tabindex, undefined); assert.equal(node.attributes.onclick, undefined);
  }
  assert.equal(source.attributes.id, "source-only", "copy sanitizing changed the real artwork");
  for (const scale of [1, 1.04, 1.1]) { f.seat.face.pressScale = scale; f.context.paintLenses(); assertCopyPosition(f, source); }
});

test("Home is bare, keeps its original artwork/accessibility, and Plus is also bare", () => {
  const house = html.match(/<button id="homeico"[^>]*>(<svg[\s\S]*?<\/svg>)<\/button>/);
  assert.ok(house); assert.doesNotMatch(house[0], /class="qn-glass"/);
  assert.match(house[0], /type="button".*aria-label="Home".*aria-pressed="false"/);
  assert.match(house[1], /width="15" height="15" viewBox="0 0 24 24"/);
  assert.match(house[1], /<path d="M3 10\.5 12 3l9 7\.5"\/><path d="M5\.5 9\.5V21h13V9\.5"\/>/);
  assert.match(html, /body\.focus #homeico\{background:none; border:none; box-shadow:none\}/);
  assert.match(html, /const tabPlus = h\("button", "ptabplus"\)/);
  assert.doesNotMatch(html, /workspaceTransition|projectEntrance|project-enter|navigateWorkspace|navigateTab/);
});
