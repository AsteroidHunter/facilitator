#!/usr/bin/env python3
"""Render the README banner from the app's own source of truth.

The banner reproduces the lockup shown at the top of the PWA installation guide
page (the `.identity` block in m-gate.html): a square logo with the name beside
it and the version stacked directly beneath. Only those three elements appear,
on a transparent background, with no panel, border, rounding, shadow, or
scenery.

Everything is lifted from the product source so the banner cannot drift:

- logo: the data-URI PNG on the installation header's `.identity img` in
  m-gate.html, drawn in a square box with contain semantics, as that page does.
- name: the text of `.name` in m-gate.html.
- version: the text of `#npversion` in index.html. This is the app's single
  version source of truth (RUNBOOK), the same string bridge_gate.py reads to
  fill the gate's version label, so there is never a second version string.

Style matches the installation header (tokens from card-tokens.css): the name is
Inter weight 650 in ink #211D17, the version is IBM Plex Mono in sub #75695A
directly below it, and the relative sizes and spacing keep the header's
64:22:12 logo:name:version proportion with a 12/4 gap. A prefers-color-scheme
media query lightens only the ink colours for dark hosts; the background stays
transparent and the geometry is unchanged.

Output is one static, self-contained SVG: no scripts and no external references,
with the logo carried inside it as a data URI. It is meant to be shown through a
plain `<img>`; static image hosts differ in what they render, so confirm the
result where it will be published.

Usage:
    python tools/readme-header/generate.py [--repo-root PATH] [--out-dir PATH]
                                           [--version vX.Y.Z]

--version is only for tests: it overrides the version WITHOUT touching
index.html, so a fixture can prove a different version flows through to the SVG.
"""

from __future__ import annotations

import argparse
import base64
import html
import re
import struct
import sys
from pathlib import Path

# --- The app's own sources ---------------------------------------------------
# Version: the exact convention bridge_gate.py uses, so the banner shares the
# app's one version source of truth (RUNBOOK, index.html #npversion).
VERSION_RE = re.compile(r'id="npversion">(v[0-9]+\.[0-9]+\.[0-9]+)<')
# Logo and name: the installation header's own lockup in m-gate.html.
LOGO_RE = re.compile(r'class="identity">\s*<img[^>]*\ssrc="(data:image/png;base64,[^"]+)"')
NAME_RE = re.compile(r'class="name">([^<]+)<')

# --- Lockup dial, mirroring m-gate.html .identity at 2x ----------------------
# Base header: logo 64, name 22, version 12, gap 12, name-to-version 4, name
# line-height 1.1, version line-height 1.4. Scaled here by 2, proportions kept.
SCALE = 2
LOGO = 64 * SCALE          # 64 -> 128 square box (object-fit: contain)
NAME_FS = 22 * SCALE       # Inter 650
VER_FS = 12 * SCALE        # IBM Plex Mono
GAP = 12 * SCALE           # logo-to-copy gap (.identity gap:12)
NV_GAP = 4 * SCALE         # name-to-version gap (.version margin-top:4)
NAME_LH = 1.1              # .name line-height
VER_LH = 1.4              # .version line-height
PAD = 16 * SCALE           # transparent breathing room around the lockup

# Colours from card-tokens.css. Dark-host variant lightens only the ink.
INK = "#211D17"            # --ink (name)
SUB = "#75695A"            # --sub (version)
INK_DARK = "#F0EDE8"       # lightened name for dark hosts
SUB_DARK = "#A79C8C"       # lightened version for dark hosts
NAME_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
VER_FONT = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

# Approximate Inter advance widths (fraction of em) for the name, used only to
# centre the lockup; unknown characters fall back to AVG_ADVANCE. IBM Plex Mono
# is monospaced, so the version uses a single fixed advance.
AVG_ADVANCE = 0.60
MONO_ADVANCE = 0.60
ADVANCE = {
    "a": .548, "b": .586, "c": .513, "d": .586, "e": .553, "f": .341, "g": .586,
    "h": .579, "i": .253, "j": .253, "k": .527, "l": .253, "m": .875, "n": .579,
    "o": .592, "p": .586, "q": .586, "r": .360, "s": .482, "t": .375, "u": .579,
    "v": .494, "w": .734, "x": .494, "y": .494, "z": .482,
    "A": .639, "B": .604, "C": .624, "D": .653, "E": .565, "F": .541, "G": .665,
    "H": .680, "I": .259, "J": .481, "K": .615, "L": .521, "M": .827, "N": .680,
    "O": .712, "P": .586, "Q": .712, "R": .607, "S": .576, "T": .569, "U": .665,
    "V": .639, "W": .887, "X": .626, "Y": .607, "Z": .580,
    "0": .573, "1": .573, "2": .573, "3": .573, "4": .573, "5": .573, "6": .573,
    "7": .573, "8": .573, "9": .573, ".": .272, " ": .250, "-": .380,
}


def _extract(pattern: re.Pattern[str], text: str, what: str, where: str) -> str:
    m = pattern.search(text)
    if not m:
        raise SystemExit(f"Could not read {what} from {where}")
    return m.group(1)


def png_size(data_uri: str) -> tuple[int, int]:
    """Intrinsic (width, height) from a base64 PNG's IHDR, so the logo keeps its
    aspect ratio inside the square box without a second hardcoded number."""
    raw = base64.b64decode(data_uri.split(",", 1)[1])
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise SystemExit("Logo data URI is not a PNG with a leading IHDR")
    width, height = struct.unpack(">II", raw[16:24])
    if width == 0 or height == 0:
        raise SystemExit("Logo reports a zero dimension")
    return width, height


def inter_width(text: str, font_size: float) -> float:
    return sum(ADVANCE.get(ch, AVG_ADVANCE) for ch in text) * font_size


def mono_width(text: str, font_size: float) -> float:
    return len(text) * MONO_ADVANCE * font_size


def build_svg(name: str, version: str, logo_uri: str) -> str:
    # Validate the logo decodes; the square box uses contain, so the intrinsic
    # size only needs to be a valid PNG (aspect handled by preserveAspectRatio).
    png_size(logo_uri)

    name_w = inter_width(name, NAME_FS)
    ver_w = mono_width(version, VER_FS)
    copy_w = max(name_w, ver_w)
    content_w = LOGO + GAP + copy_w

    canvas_w = round(content_w + 2 * PAD)
    canvas_h = round(LOGO + 2 * PAD)
    group_x = (canvas_w - content_w) / 2
    center_y = canvas_h / 2

    logo_x = group_x
    logo_y = center_y - LOGO / 2

    text_x = group_x + LOGO + GAP
    # Centre the name-over-version column against the logo centre.
    copy_h = NAME_FS * NAME_LH + NV_GAP + VER_FS * VER_LH
    copy_top = center_y - copy_h / 2
    name_baseline = copy_top + 0.80 * NAME_FS
    ver_baseline = copy_top + NAME_FS * NAME_LH + NV_GAP + 0.80 * VER_FS

    safe_name = html.escape(name)
    safe_ver = html.escape(version)

    return f"""<svg xmlns="http://www.w3.org/2000/svg" \
xmlns:xlink="http://www.w3.org/1999/xlink" \
width="{canvas_w}" height="{canvas_h}" viewBox="0 0 {canvas_w} {canvas_h}" \
role="img" aria-label="{safe_name} {safe_ver}">
  <title>{safe_name} {safe_ver}</title>
  <style>
    .name {{ font-family: {NAME_FONT}; font-weight: 650; font-size: {NAME_FS}px; fill: {INK}; }}
    .ver  {{ font-family: {VER_FONT}; font-weight: 400; font-size: {VER_FS}px; fill: {SUB}; }}
    @media (prefers-color-scheme: dark) {{
      .name {{ fill: {INK_DARK}; }}
      .ver  {{ fill: {SUB_DARK}; }}
    }}
  </style>
  <image x="{logo_x:.2f}" y="{logo_y:.2f}" width="{LOGO}" height="{LOGO}" \
xlink:href="{logo_uri}" preserveAspectRatio="xMidYMid meet"/>
  <text class="name" x="{text_x:.2f}" y="{name_baseline:.2f}">{safe_name}</text>
  <text class="ver" x="{text_x:.2f}" y="{ver_baseline:.2f}">{safe_ver}</text>
</svg>
"""


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument(
        "--version",
        default=None,
        help="Test-only override; does NOT touch index.html.",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    repo_root = (args.repo_root or script_dir.parents[1]).resolve()
    out_dir = (args.out_dir or script_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    index_path = repo_root / "index.html"
    gate_path = repo_root / "m-gate.html"
    for pth in (index_path, gate_path):
        if not pth.exists():
            raise SystemExit(f"Required source file not found: {pth}")
    index_html = index_path.read_text(encoding="utf-8")
    gate_html = gate_path.read_text(encoding="utf-8")

    name = _extract(NAME_RE, gate_html, "the name (.name)", gate_path.name)
    logo_uri = _extract(LOGO_RE, gate_html, "the logo (.identity img)", gate_path.name)
    version = args.version or _extract(VERSION_RE, index_html, "the version (#npversion)", index_path.name)

    svg = build_svg(name, version, logo_uri)
    out_svg = out_dir / "facilitator-header.svg"
    out_svg.write_text(svg, encoding="utf-8")

    print(f"wrote {out_svg}")
    print(f"name {name!r} (source: {gate_path})")
    print(f"logo source: {gate_path}")
    print(f"version {version} (source: {index_path})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
