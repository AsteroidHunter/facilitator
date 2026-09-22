#!/usr/bin/env python3
"""Render the README banner from the app's own source of truth.

The banner is a wide rounded panel carrying the same logo/name/version lockup
the app shows on first open (the `#npbrand` block in index.html, styled by the
badge rules in card-tokens.css). It keeps only that lockup's three elements,
with no background scenery: logo, name, version.

Everything is lifted straight out of index.html so the banner cannot drift from
the app:

- logo: the embedded data-URI PNG on `#npmark`, reused as-is (the same artwork
  the PWA header ships), so there is no second logo file to keep in step.
- name: the text of `#npbrandname`.
- version: the text of `#npversion`. This is the app's single version source of
  truth (RUNBOOK), the same string bridge_gate.py reads for the phone gate, so
  there is never a second version string to maintain.

Output is one static, self-contained SVG: no scripts and no external references,
with the logo carried inside it as a data URI. The panel is an opaque warm-paper
rectangle with rounded corners, so it reads the same on a light or dark README
and needs no light/dark split. It is meant to be shown through a plain `<img>`;
static image hosts differ in what they render, so confirm the result where it
will be published.

Palette and font come from card-tokens.css (paper #F5F4F1, ink #211D17,
sub #75695A, the Inter stack). Text stays as `<text>` in the Inter/-apple-system
stack; when a viewer lacks Inter it falls back to the platform sans, so the
banner still reads.

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

# --- The app's single sources, lifted from index.html -----------------------
# Version: the exact convention bridge_gate.py uses for the phone gate, so the
# banner shares the app's one version source of truth (RUNBOOK, #npversion).
VERSION_RE = re.compile(r'id="npversion">(v[0-9]+\.[0-9]+\.[0-9]+)<')
NAME_RE = re.compile(r'id="npbrandname">([^<]+)<')
LOGO_RE = re.compile(r'id="npmark"[^>]*\ssrc="(data:image/png;base64,[^"]+)"')

# --- Banner geometry, in the SVG's own user units ----------------------------
# A fixed panel wide enough that the centred lockup never risks clipping and
# small errors in the text-width estimate below stay invisible.
PANEL_W = 880
PANEL_H = 240
PANEL_RADIUS = 22

# Palette + font, from card-tokens.css.
PAPER = "#F5F4F1"
INK = "#211D17"
SUB = "#75695A"
LINE_STRONG = "#D8CFBE"
FONT_STACK = (
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', "
    "Roboto, Helvetica, Arial, sans-serif"
)

# Lockup dial. The app pairs a 32px-tall mark with a 40px name (0.8 ratio) and a
# 10px version; the banner keeps those ratios, scaled up. Letter-spacing mirrors
# the app (name -0.02em, version +0.035em), expressed in user units below.
NAME_FS = 88
LOGO_H = round(NAME_FS * 0.8)          # 70
VER_FS = 22
LOGO_GAP = 16                          # mark-to-text gap
NAME_TRACKING = -0.02 * NAME_FS        # px
VER_TRACKING = 0.035 * VER_FS          # px
# The name's optical centre sits a hair above the panel centre so the version
# hangs into the space below it, as it does under the app's name.
NAME_CENTER_LIFT = 10
VER_BASELINE_DROP = 26                 # version baseline below the name baseline

# Approximate Inter advance widths (fraction of em) for horizontal centring.
# Centring only; the panel is far wider than the lockup, so small errors do not
# show. Unknown characters fall back to AVG_ADVANCE.
AVG_ADVANCE = 0.60
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


def _extract(pattern: re.Pattern[str], text: str, what: str) -> str:
    m = pattern.search(text)
    if not m:
        raise SystemExit(f"Could not read {what} from index.html")
    return m.group(1)


def png_size(data_uri: str) -> tuple[int, int]:
    """Intrinsic (width, height) from a base64 PNG's IHDR, so the logo keeps its
    aspect ratio without a second hardcoded number."""
    raw = base64.b64decode(data_uri.split(",", 1)[1])
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise SystemExit("Logo data URI is not a PNG with a leading IHDR")
    width, height = struct.unpack(">II", raw[16:24])
    if width == 0 or height == 0:
        raise SystemExit("Logo reports a zero dimension")
    return width, height


def text_width(text: str, font_size: int, tracking: float) -> float:
    advance = sum(ADVANCE.get(ch, AVG_ADVANCE) for ch in text) * font_size
    if len(text) > 1:
        advance += tracking * (len(text) - 1)
    return advance


def build_svg(name: str, version: str, logo_uri: str) -> str:
    logo_w_px, logo_h_px = png_size(logo_uri)
    logo_w = LOGO_H * (logo_w_px / logo_h_px)

    name_w = text_width(name, NAME_FS, NAME_TRACKING)
    ver_w = text_width(version, VER_FS, VER_TRACKING)
    text_block_w = max(name_w, ver_w)
    lockup_w = logo_w + LOGO_GAP + text_block_w

    group_x = (PANEL_W - lockup_w) / 2
    center_y = PANEL_H / 2

    logo_x = group_x
    logo_y = center_y - NAME_CENTER_LIFT - LOGO_H / 2

    text_x = group_x + logo_w + LOGO_GAP
    # Inter cap height is ~0.72em; place the baseline so the cap centres on the
    # lifted name centre.
    name_baseline = (center_y - NAME_CENTER_LIFT) + 0.72 * NAME_FS / 2
    ver_baseline = name_baseline + VER_BASELINE_DROP

    safe_name = html.escape(name)
    safe_ver = html.escape(version)

    return f"""<svg xmlns="http://www.w3.org/2000/svg" \
xmlns:xlink="http://www.w3.org/1999/xlink" \
width="{PANEL_W}" height="{PANEL_H}" viewBox="0 0 {PANEL_W} {PANEL_H}" \
role="img" aria-label="{safe_name} {safe_ver}">
  <title>{safe_name} {safe_ver}</title>
  <rect x="0.5" y="0.5" width="{PANEL_W - 1}" height="{PANEL_H - 1}" \
rx="{PANEL_RADIUS}" ry="{PANEL_RADIUS}" fill="{PAPER}" \
stroke="{LINE_STRONG}" stroke-width="1"/>
  <image x="{logo_x:.2f}" y="{logo_y:.2f}" width="{logo_w:.2f}" \
height="{LOGO_H}" xlink:href="{logo_uri}" \
preserveAspectRatio="xMidYMid meet"/>
  <text x="{text_x:.2f}" y="{name_baseline:.2f}" \
font-family="{FONT_STACK}" font-size="{NAME_FS}" font-weight="700" \
letter-spacing="{NAME_TRACKING:.2f}" fill="{INK}">{safe_name}</text>
  <text x="{text_x:.2f}" y="{ver_baseline:.2f}" \
font-family="{FONT_STACK}" font-size="{VER_FS}" font-weight="500" \
letter-spacing="{VER_TRACKING:.2f}" fill="{SUB}">{safe_ver}</text>
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
    if not index_path.exists():
        raise SystemExit(f"Required source file not found: {index_path}")
    index_html = index_path.read_text(encoding="utf-8")

    name = _extract(NAME_RE, index_html, "the brand name (#npbrandname)")
    logo_uri = _extract(LOGO_RE, index_html, "the logo (#npmark)")
    version = args.version or _extract(VERSION_RE, index_html, "the version (#npversion)")

    svg = build_svg(name, version, logo_uri)
    out_svg = out_dir / "facilitator-header.svg"
    out_svg.write_text(svg, encoding="utf-8")

    print(f"wrote {out_svg} ({PANEL_W}x{PANEL_H})")
    print(f"name {name!r}")
    print(f"version {version} (source: {index_path})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
