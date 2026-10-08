// What a send's flight hands the browser, read back at a moment of the flight:
// each layer's transform keyframes joined straight, as the browser runs them,
// the four clips composed into the box they cut out, and the words' transform.
// A layer with no animation yet stands where its inline transform puts it.
// Used by the send motion tests' stand-in pages, whose animate() keeps every
// animation it is asked for on the node (node.animations).
const numbers = text => (String(text || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);

// the animation a layer is running: the newest one not cancelled
function running(node) {
  return (node.animations || []).filter(run => run.playState !== "idle" && !run.cancelled).at(-1) || null;
}

// the numbers of a layer's transform at ms of its animation
function valueAt(node, ms) {
  const run = running(node);
  if (!run) return numbers(node.style.transform);
  const keys = run.keys, length = run.options.duration;
  const f = Math.max(0, Math.min(1, ms / length));
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].offset < f) i++;
  const a = keys[i], b = keys[i + 1];
  const p = b.offset > a.offset ? Math.max(0, Math.min(1, (f - a.offset) / (b.offset - a.offset))) : 0;
  const va = numbers(a.transform), vb = numbers(b.transform);
  return va.map((v, k) => v + (vb[k] - v) * p);
}

// the box the clips cut out at ms, in viewport px, and the words' place in it
// and scale (x and y from the box's top left, as the frame-by-frame flight
// wrote them); origin is where the ground stands, which is the viewport's
// origin when the chain holds together
function drawn(shell, ms) {
  const clips = shell.querySelectorAll(".sentmorph-clip");
  if (clips.length !== 4) throw new Error("the flight has " + clips.length + " clips, not four");
  const ground = shell.querySelector(".sentmorph-ground");
  const words = shell.querySelector(".sentmorph-target");
  const [c1, c2, c3, c4] = clips.map(clip => valueAt(clip, ms));
  const g = valueAt(ground, ms);
  const room = { width: parseFloat(clips[0].style.width), height: parseFloat(clips[0].style.height) };
  const left = c1[0], top = c1[1], width = c2[0] + room.width, height = c3[1] + room.height;
  const w = valueAt(words, ms);
  return {
    left, top, width, height, right: left + width, bottom: top + height,
    origin: { x: c1[0] + c2[0] + c3[0] + c4[0] + g[0], y: c1[1] + c2[1] + c3[1] + c4[1] + g[1] },
    words: { x: w[0] - left, y: w[1] - top, k: w[2], ky: w[3] },
  };
}

module.exports = { drawn, running, valueAt, numbers };
