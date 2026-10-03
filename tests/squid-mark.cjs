// Reads the squid on a settings button back as drawn. Run inside the page:
//   await page.evaluate(readMark, "#setbtn")
// It paints the button's svg at 8 pixels to the unit on a canvas and reports the fills, whether
// anything is stroked, the colours that reached the canvas, and how far the paint stands in
// from each edge of the svg's box, all in the svg's own units.
async function readMark(selector) {
  const K = 8;
  const svg = document.querySelector(selector).querySelector("svg");
  const w = Number(svg.getAttribute("width")), h = Number(svg.getAttribute("height"));
  const paths = [...svg.querySelectorAll("path")];
  const copy = svg.cloneNode(true);
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", w * K);
  copy.setAttribute("height", h * K);
  const img = new Image();
  await new Promise((done, fail) => {
    img.onload = done;
    img.onerror = () => fail(new Error("the mark did not load as an image"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
  });
  const canvas = document.createElement("canvas");
  canvas.width = w * K;
  canvas.height = h * K;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const near = (i, rgb) => rgb.every((v, n) => Math.abs(data[i + n] - v) <= 4);
  let orange = 0, black = 0, other = 0, minX = w * K, minY = h * K, maxX = -1, maxY = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const i = (y * canvas.width + x) * 4;
    if (data[i + 3] === 0) continue;
    if (data[i + 3] !== 255) other++;
    else if (near(i, [248, 157, 15])) orange++;
    else if (near(i, [12, 11, 10])) black++;
    else other++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    w, h,
    fills: paths.map(p => p.getAttribute("fill")),
    stroked: !!svg.getAttribute("stroke") || paths.some(p => getComputedStyle(p).stroke !== "none"),
    orange: orange / (K * K), black: black / (K * K), other,
    top: minY / K, bottom: h - (maxY + 1) / K, left: minX / K, right: w - (maxX + 1) / K,
  };
}

module.exports = { readMark };
