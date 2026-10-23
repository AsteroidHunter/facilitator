#!/usr/bin/env python3
"""Cut every raster copy of the squid logo from the source, with crisp edges.

Run from the top of the repo (standard library only, about a minute):

    python3 app/tools/squid-logo/build_logo.py

The source (app/assets/facilitator_logo_blank_v0.3.png) is pixel art, but its
blocks are not on one regular grid: block edges sit at uneven spacings, the
best lattice fits them only a little better than chance, and the head tip is
slightly tilted. So there is no single block size and offset to snap to. Instead each output pixel is decided from
the source pixels whose centres fall inside it, and is never a blend:

- ink if at least half of those source pixels have alpha 128 or more, else
  background (transparent for the lockups and splash, the icon background for
  the icons);
- an ink pixel takes the palette colour most of its source pixels are closest
  to: orange, black or the eye shine.

So every output has the background and at most three flat colours, and no edge
pixel is a blend of two of them.

Each file keeps the place and size it had: the squid centred, the lockups and
splash in a square window sized so the squid is 0.893 of the picture's height,
the icons at their old width on the background (252, 251, 249) (the phone app's
own icons at 0.9 of it), and the phone button cut to the squid's own bounds.
"""

from __future__ import annotations

import argparse
import base64
import re
import struct
import sys
import zlib
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
SOURCE = APP / "assets" / "facilitator_logo_blank_v0.3.png"

ORANGE = (255, 156, 46)
BLACK = (0, 0, 0)
SHINE = (255, 247, 176)
PALETTE = (ORANGE, BLACK, SHINE)
BACKGROUND = (252, 251, 249)        # the icons' own background

# The squid's bounds in the source (alpha above 2; faint stray pixels reach the
# corners, so "any alpha" would return the whole file), as the tests pin them.
BOUNDS = (15, 29, 2103, 2046)       # x, y, width, height
# The squid's solid extent (alpha 128 or more), used to centre and size the icons.
SOLID = (18, 32, 2097, 2041)        # x, y, width, height
WINDOW_SHARE = 0.893                # squid height over picture height in the lockups and splash

# The Mac app's manifest and the favicon link share m-icon-192.png and
# m-icon-512.png, so those stay at full size. The phone app's own icons (the
# apple-touch-icon and the phone manifest's pair) draw the squid smaller, by
# PHONE_ICON_SCALE or the --phone-scale option.
PHONE_ICON_SCALE = 0.9
ICON_SIDES = {"m-icon-180.png": 180, "m-icon-192.png": 192, "m-icon-512.png": 512,
              "m-icon-phone-192.png": 192, "m-icon-phone-512.png": 512}
PHONE_ONLY = ("m-icon-180.png", "m-icon-phone-192.png", "m-icon-phone-512.png")
ICON_SQUID_WIDTH = {180: 156, 192: 166, 512: 442}   # the drawn squid's width at full size


def read_png(path):
    raw = Path(path).read_bytes()
    pos, idat, head = 8, [], None
    while pos < len(raw):
        n = struct.unpack(">I", raw[pos:pos + 4])[0]
        kind, body = raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            head = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        pos += n + 12
    w, h, depth, ctype, _, _, interlace = head
    if (depth, ctype, interlace) != (8, 6, 0):
        raise SystemExit("the source must be 8-bit RGBA with no interlace")
    data, stride = zlib.decompress(b"".join(idat)), w * 4
    out, prev, p = bytearray(h * stride), bytearray(stride), 0
    for y in range(h):
        f, line = data[p], bytearray(data[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def write_png(w, h, pixels, channels):
    """8-bit PNG, `channels` 3 (RGB) or 4 (RGBA), no filter, no palette."""
    stride = w * channels
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    ctype = 6 if channels == 4 else 2
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def classify(w, h, rgba):
    """One byte per source pixel: 0 background, 1 orange, 2 black, 3 shine."""
    kinds = bytearray(w * h)
    for i in range(w * h):
        if rgba[i * 4 + 3] < 128:
            continue
        r, g, b = rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]
        best, which = None, 1
        for k, (pr, pg, pb) in enumerate(PALETTE):
            d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
            if best is None or d < best:
                best, which = d, k + 1
        kinds[i] = which
    return kinds


def solid_extent(w, h, kinds):
    xs0, ys0, xs1, ys1 = w, h, -1, -1
    for y in range(h):
        row = kinds[y * w:(y + 1) * w]
        if any(row):
            xs0, xs1 = min(xs0, next(x for x in range(w) if row[x])), max(xs1, w - 1 - next(x for x in range(w) if row[w - 1 - x]))
            ys0, ys1 = min(ys0, y), max(ys1, y)
    return xs0, ys0, xs1 - xs0 + 1, ys1 - ys0 + 1


def render(w, h, kinds, out_w, out_h, scale_x, scale_y, origin_x, origin_y):
    """Out pixel (u, v) takes the source pixels whose centres land in it:
    source x -> (x + 0.5 - origin_x) * scale_x. Returns one class per out pixel."""
    cols = [-1] * w
    for x in range(w):
        u = int((x + 0.5 - origin_x) * scale_x // 1)
        if 0 <= u < out_w:
            cols[x] = u
    # counts[v][u] = [total pixels, background, orange, black, shine]
    counts = [[[0, 0, 0, 0, 0] for _ in range(out_w)] for _ in range(out_h)]
    for y in range(h):
        v = int((y + 0.5 - origin_y) * scale_y // 1)
        if not 0 <= v < out_h:
            continue
        row, line = kinds[y * w:(y + 1) * w], counts[v]
        for x in range(w):
            u = cols[x]
            if u >= 0:
                cell = line[u]
                cell[0] += 1
                cell[1 + row[x]] += 1
    result = bytearray(out_w * out_h)
    for v in range(out_h):
        for u in range(out_w):
            total, bg, o, k, s = counts[v][u]
            if total == 0 or bg * 2 > total:      # fewer than half the pixels are ink
                continue
            ink = (o, k, s)
            result[v * out_w + u] = 1 + ink.index(max(ink))
    return result


def to_pixels(kinds_out, out_w, out_h, background):
    """background: None for transparent RGBA, or an (r, g, b) for opaque RGB."""
    if background is None:
        # transparent pixels carry the orange, so a viewer that scales without
        # premultiplying cannot pull a dark edge in from them
        table = [ORANGE + (0,)] + [c + (255,) for c in PALETTE]
        channels = 4
    else:
        table = [background] + list(PALETTE)
        channels = 3
    out = bytearray()
    for k in kinds_out:
        out += bytes(table[k])
    return write_png(out_w, out_h, out, channels)


def frame_window(side_out):
    """Square window centred on the squid's bounds, squid 0.893 of its height."""
    bx, by, bw, bh = BOUNDS
    window = bh / WINDOW_SHARE
    scale = side_out / window
    return scale, scale, bx + bw / 2 - window / 2, by + bh / 2 - window / 2


def frame_icon(side_out, squid_width):
    """Squid's solid extent centred on the canvas at the width it had."""
    sx, sy, sw, sh = SOLID
    scale = squid_width / sw
    return scale, scale, sx + sw / 2 - side_out / 2 / scale, sy + sh / 2 - side_out / 2 / scale


def frame_button(out_w, out_h):
    bx, by, bw, bh = BOUNDS
    return out_w / bw, out_h / bh, bx, by


def replace_inline(path, png):
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(r"data:image/png;base64,[A-Za-z0-9+/=]+")
    if len(pattern.findall(text)) != 1:
        raise SystemExit(f"{path.name}: expected exactly one inline PNG")
    uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    path.write_text(pattern.sub(lambda m: uri, text), encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Cut every raster copy of the squid logo.")
    parser.add_argument("--phone-scale", type=float, default=PHONE_ICON_SCALE,
                        help="the squid's drawn width in the phone app's icons, as a share of full size (default %(default)s)")
    phone_scale = parser.parse_args(argv).phone_scale
    w, h, rgba = read_png(SOURCE)
    kinds = classify(w, h, rgba)
    found = solid_extent(w, h, kinds)
    if found != SOLID:
        raise SystemExit(f"the squid's solid extent is {found}, not {SOLID}: update SOLID and BOUNDS")
    assets = APP / "assets"

    for name, side in ICON_SIDES.items():
        scale = phone_scale if name in PHONE_ONLY else 1.0
        out = render(w, h, kinds, side, side, *frame_icon(side, ICON_SQUID_WIDTH[side] * scale))
        (assets / name).write_bytes(to_pixels(out, side, side, BACKGROUND))
        print("wrote", name)

    splash = render(w, h, kinds, 640, 640, *frame_window(640))
    (assets / "m-splash-squid.png").write_bytes(to_pixels(splash, 640, 640, None))
    print("wrote m-splash-squid.png")

    lockup = to_pixels(render(w, h, kinds, 192, 192, *frame_window(192)), 192, 192, None)
    replace_inline(APP / "index.html", lockup)
    replace_inline(APP / "m-gate.html", lockup)
    print("wrote the inline lockups in index.html and m-gate.html")

    button = to_pixels(render(w, h, kinds, 123, 120, *frame_button(123, 120)), 123, 120, None)
    replace_inline(APP / "m.html", button)
    print("wrote the inline button in m.html")


if __name__ == "__main__":
    sys.exit(main())
