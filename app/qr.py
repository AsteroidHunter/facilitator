"""A small QR code encoder with no dependencies: byte mode, versions 1 to 10,
all four error correction levels, and the mask chosen by the standard penalty
rules. Written for this repository so the facilitator CLI can print the phone
page's address as a code a phone camera reads, without a third party package.

    matrix = encode("https://example.ts.net/m")   # list of rows of booleans, True is dark
    for line in render(matrix): print(line)        # half block characters, two rows per line
"""

# ---- GF(256), the field the Reed-Solomon codewords live in -----------------
_EXP = [0] * 512
_LOG = [0] * 256
_v = 1
for _i in range(255):
    _EXP[_i] = _v
    _LOG[_v] = _i
    _v <<= 1
    if _v & 0x100:
        _v ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _generator(n: int) -> list:
    """The generator polynomial for n error correction codewords, highest
    degree first: the product of (x + a^i) for i from 0 to n - 1."""
    g = [1]
    for i in range(n):
        nxt = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            nxt[j] ^= c
            nxt[j + 1] ^= _mul(c, _EXP[i])
        g = nxt
    return g


def _ec_codewords(data: list, n: int) -> list:
    g = _generator(n)
    res = list(data) + [0] * n
    for i in range(len(data)):
        coef = res[i]
        if coef:
            for j in range(1, len(g)):
                res[i + j] ^= _mul(g[j], coef)
    return res[len(data):]


# ---- the block layout for every version and level ---------------------------
# (error correction codewords per block, group 1 block count, group 1 data
# codewords per block, group 2 block count, group 2 data codewords per block)
_LEVELS = {"L": 0, "M": 1, "Q": 2, "H": 3}
_LEVEL_BITS = {"L": 0b01, "M": 0b00, "Q": 0b11, "H": 0b10}
_BLOCKS = {
    1: [(7, 1, 19, 0, 0), (10, 1, 16, 0, 0), (13, 1, 13, 0, 0), (17, 1, 9, 0, 0)],
    2: [(10, 1, 34, 0, 0), (16, 1, 28, 0, 0), (22, 1, 22, 0, 0), (28, 1, 16, 0, 0)],
    3: [(15, 1, 55, 0, 0), (26, 1, 44, 0, 0), (18, 2, 17, 0, 0), (22, 2, 13, 0, 0)],
    4: [(20, 1, 80, 0, 0), (18, 2, 32, 0, 0), (26, 2, 24, 0, 0), (16, 4, 9, 0, 0)],
    5: [(26, 1, 108, 0, 0), (24, 2, 43, 0, 0), (18, 2, 15, 2, 16), (22, 2, 11, 2, 12)],
    6: [(18, 2, 68, 0, 0), (16, 4, 27, 0, 0), (24, 4, 19, 0, 0), (28, 4, 15, 0, 0)],
    7: [(20, 2, 78, 0, 0), (18, 4, 31, 0, 0), (18, 2, 14, 4, 15), (26, 4, 13, 1, 14)],
    8: [(24, 2, 97, 0, 0), (22, 2, 38, 2, 39), (22, 4, 18, 2, 19), (26, 4, 14, 2, 15)],
    9: [(30, 2, 116, 0, 0), (22, 3, 36, 2, 37), (20, 4, 16, 4, 17), (24, 4, 12, 4, 13)],
    10: [(18, 2, 68, 2, 69), (26, 4, 43, 1, 44), (24, 6, 19, 2, 20), (28, 6, 15, 2, 16)],
}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
          7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]}
_REMAINDER = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0}


def _data_capacity(version: int, level: str) -> int:
    ec, g1, g1w, g2, g2w = _BLOCKS[version][_LEVELS[level]]
    return g1 * g1w + g2 * g2w


def _pick_version(nbytes: int, level: str) -> int:
    for v in range(1, 11):
        count_bits = 8 if v <= 9 else 16
        if 4 + count_bits + 8 * nbytes <= 8 * _data_capacity(v, level):
            return v
    raise ValueError("text too long for a version 10 code")


def _codewords(data: bytes, version: int, level: str) -> list:
    """The data codewords: mode, length, the bytes, terminator, padding."""
    bits = []

    def put(val, n):
        for i in range(n - 1, -1, -1):
            bits.append((val >> i) & 1)

    put(0b0100, 4)
    put(len(data), 8 if version <= 9 else 16)
    for b in data:
        put(b, 8)
    cap = 8 * _data_capacity(version, level)
    put(0, min(4, cap - len(bits)))
    while len(bits) % 8:
        bits.append(0)
    out = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = (0xEC, 0x11)
    i = 0
    while len(out) < cap // 8:
        out.append(pad[i % 2])
        i += 1
    return out


def _interleave(data: list, version: int, level: str) -> list:
    ec, g1, g1w, g2, g2w = _BLOCKS[version][_LEVELS[level]]
    blocks, at = [], 0
    for count, width in ((g1, g1w), (g2, g2w)):
        for _ in range(count):
            blocks.append(data[at:at + width])
            at += width
    ecs = [_ec_codewords(b, ec) for b in blocks]
    out = []
    for i in range(max(len(b) for b in blocks)):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(ec):
        for e in ecs:
            out.append(e[i])
    return out


# ---- the matrix --------------------------------------------------------------
def _function_patterns(size: int, version: int):
    """The fixed modules: finders with their separators, timing lines, the
    alignment squares, the dark module, and the room kept for format and
    version information. Returns (modules, reserved), both size x size."""
    m = [[False] * size for _ in range(size)]
    r = [[False] * size for _ in range(size)]

    def finder(top, left):
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                y, x = top + dy, left + dx
                if not (0 <= y < size and 0 <= x < size):
                    continue
                inside = 0 <= dy <= 6 and 0 <= dx <= 6
                ring = inside and (dy in (0, 6) or dx in (0, 6))
                core = inside and 2 <= dy <= 4 and 2 <= dx <= 4
                m[y][x] = ring or core
                r[y][x] = True

    finder(0, 0)
    finder(0, size - 7)
    finder(size - 7, 0)
    for i in range(8, size - 8):
        m[6][i] = m[i][6] = (i % 2 == 0)
        r[6][i] = r[i][6] = True
    centres = _ALIGN[version]
    for cy in centres:
        for cx in centres:
            # the three squares that would land on a finder are left out; the
            # ones on the timing lines from version 7 up are drawn over them
            if (cy < 9 and cx < 9) or (cy < 9 and cx > size - 10) or (cy > size - 10 and cx < 9):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    m[cy + dy][cx + dx] = max(abs(dy), abs(dx)) != 1
                    r[cy + dy][cx + dx] = True
    m[size - 8][8] = True
    r[size - 8][8] = True
    for i in range(9):
        r[8][i] = r[i][8] = True
    for i in range(8):
        r[8][size - 1 - i] = r[size - 1 - i][8] = True
    if version >= 7:
        for i in range(6):
            for j in range(3):
                r[i][size - 11 + j] = r[size - 11 + j][i] = True
    return m, r


def _place_data(m, r, size, bits):
    col, row_up, i = size - 1, True, 0
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if row_up else range(size)
        for y in rows:
            for x in (col, col - 1):
                if not r[y][x]:
                    m[y][x] = bool(bits[i]) if i < len(bits) else False
                    i += 1
        col -= 2
        row_up = not row_up


_MASKS = [
    lambda y, x: (y + x) % 2 == 0,
    lambda y, x: y % 2 == 0,
    lambda y, x: x % 3 == 0,
    lambda y, x: (y + x) % 3 == 0,
    lambda y, x: (y // 2 + x // 3) % 2 == 0,
    lambda y, x: (y * x) % 2 + (y * x) % 3 == 0,
    lambda y, x: ((y * x) % 2 + (y * x) % 3) % 2 == 0,
    lambda y, x: ((y + x) % 2 + (y * x) % 3) % 2 == 0,
]


def _apply_mask(m, r, size, mask):
    f = _MASKS[mask]
    return [[m[y][x] ^ (not r[y][x] and f(y, x)) for x in range(size)] for y in range(size)]


def _bch(value: int, poly: int, data_bits: int, total_bits: int) -> int:
    """Append the BCH remainder used by the format and version fields."""
    rem = value << (total_bits - data_bits)
    top = poly.bit_length() - 1
    for i in range(total_bits - 1, top - 1, -1):
        if rem & (1 << i):
            rem ^= poly << (i - top)
    return (value << (total_bits - data_bits)) | rem


def format_bits(level: str, mask: int) -> int:
    """The 15 bit format field for a level and mask, after the fixed XOR."""
    return _bch((_LEVEL_BITS[level] << 3) | mask, 0x537, 5, 15) ^ 0x5412


def version_bits(version: int) -> int:
    """The 18 bit version field, only present from version 7 up."""
    return _bch(version, 0x1F25, 6, 18)


def _write_format(m, size, level, mask):
    bits = format_bits(level, mask)
    bit = lambda i: bool((bits >> i) & 1)
    for i in range(6):
        m[8][i] = bit(14 - i)
        m[i][8] = bit(i)
    m[8][7] = bit(8)
    m[8][8] = bit(7)
    m[7][8] = bit(6)
    for i in range(7):
        m[size - 1 - i][8] = bit(14 - i)
    for i in range(8):
        m[8][size - 8 + i] = bit(7 - i)


def _write_version(m, size, version):
    if version < 7:
        return
    bits = version_bits(version)
    for i in range(18):
        b = bool((bits >> i) & 1)
        m[size - 11 + i % 3][i // 3] = b
        m[i // 3][size - 11 + i % 3] = b


def _penalty(m, size) -> int:
    score = 0
    for lines in (m, [list(col) for col in zip(*m)]):
        for line in lines:
            run, prev = 0, None
            for v in line:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        score += 3 + run - 5
                    run, prev = 1, v
            if run >= 5:
                score += 3 + run - 5
            s = "".join("1" if v else "0" for v in line)
            score += 40 * (s.count("10111010000") + s.count("00001011101"))
    for y in range(size - 1):
        for x in range(size - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                score += 3
    dark = sum(sum(row) for row in m)
    pct = dark * 100 // (size * size)
    low, high = pct - pct % 5, pct - pct % 5 + 5
    score += 10 * min(abs(low - 50), abs(high - 50)) // 5
    return score


def encode(text: str, level: str = "M") -> list:
    """The finished symbol for text as rows of booleans, True for a dark
    module. No quiet zone: render adds one."""
    if level not in _LEVELS:
        raise ValueError("level must be one of L, M, Q, H")
    data = text.encode("utf-8")
    version = _pick_version(len(data), level)
    size = 17 + 4 * version
    words = _interleave(_codewords(data, version, level), version, level)
    bits = [(w >> i) & 1 for w in words for i in range(7, -1, -1)] + [0] * _REMAINDER[version]
    base, reserved = _function_patterns(size, version)
    _place_data(base, reserved, size, bits)
    best, best_score = None, None
    for mask in range(8):
        cand = _apply_mask(base, reserved, size, mask)
        _write_format(cand, size, level, mask)
        _write_version(cand, size, version)
        score = _penalty(cand, size)
        if best_score is None or score < best_score:
            best, best_score = cand, score
    return best


def render(matrix: list, quiet: int = 1) -> list:
    """Lines of text drawing the code two module rows per line with the half
    block characters, dark modules as the block, with a quiet zone of light
    modules all round it. The standard asks for four; on a terminal that is
    a wide box round the code, and one module is enough: Apple's Vision and
    CoreImage decoders both read the terminal rendering with one at every
    size, cell shape and colour theme tried, camera blur and tilt included."""
    size = len(matrix)
    width = size + 2 * quiet
    rows = [[False] * width for _ in range(quiet)]
    rows += [[False] * quiet + list(r) + [False] * quiet for r in matrix]
    rows += [[False] * width for _ in range(quiet)]
    if len(rows) % 2:
        rows.append([False] * width)
    out = []
    for y in range(0, len(rows), 2):
        top, bottom = rows[y], rows[y + 1]
        line = []
        for x in range(width):
            line.append("█" if top[x] and bottom[x] else
                        "▀" if top[x] else
                        "▄" if bottom[x] else " ")
        out.append("".join(line))
    return out


if __name__ == "__main__":
    import sys
    for line in render(encode(" ".join(sys.argv[1:]) or "https://example.ts.net/m")):
        print(line)
