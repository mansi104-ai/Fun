"""
Finds the SCL results table in a screenshot and reads its 6 x 11 numbers.

Classical computer vision only -- no model, no API key, nothing over the
network. The table is a drawn grid, so the cells are located geometrically
first; then each cell is read by matching its pixels against the shapes of
the ANSYS font's characters (see "Reading the cells" below).

The pixel facts the grid search keys on, measured from a real 968x823
screenshot:

    panel background   160    the grey around the table
    table rules        192    the 1px lines of the grid
    outer border       100
    cell background    255    white

so a rule is a line where the whole width is non-white, and a cell is white.
The graph never enters the picture: only the cells inside the found grid are
read, and the plot lies hundreds of pixels below the last of them.
"""

import json
import os
import re
import shutil
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from PIL import Image, ImageOps

NON_WHITE = 200           # grey 160 and rule 192 fall below it; cells (255) don't
WHITE = 240
WIDTH_FRACTION = 0.80     # a rule spans the pane; a row of numbers does not
MAX_RULE_THICKNESS = 4    # a thin line, not the filled title bar at the top
MAX_RULE_GAP = 40         # rules sit ~17px apart; the graph's lines are ~250px
MIN_RULES = 4
COLUMN_WHITE_FRACTION = 0.15
CELL_ROW_FRACTION = 0.30  # a row of cells is ~70% white; a rule row is ~0%
MAX_RULE_PITCH_DRIFT = 1.5  # a missing middle rule leaves a gap of ~2 pitches

# The SCL worksheet always has a Subtype column plus these 11, and six rows
# under one header row. Those counts are the grid's shape, so finding a
# different shape means the grid was not found -- better to say so than to
# read whatever was there.
COLUMNS = ["SX", "SY", "SZ", "SXY", "SYZ", "SXZ", "S1", "S2", "S3", "SINT", "SEQV"]
SUBTYPES = [
    "Membrane", "Bending (Inside)", "Bending (Outside)",
    "Membrane+Bending (Inside)", "Membrane+Bending (Center)",
    "Membrane+Bending (Outside)",
]
EXPECTED_V_RULES = len(COLUMNS) + 2      # 11 numeric columns + the label column
EXPECTED_H_RULES = len(SUBTYPES) + 2     # 6 data rows + the header row

OCR_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789.-e+"
UPSCALE = 6               # a ~47x16 cell is too small for OCR until it isn't
OCR_MARGIN = 30           # white space around the upscaled cell

TESSERACT_CANDIDATES = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    "/usr/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/opt/homebrew/bin/tesseract",
]


class TableNotFound(Exception):
    """The grid was not recognised, so nothing was read."""


def find_tesseract(override=None):
    """The Tesseract binary, or None. PATH first, then the usual install spots."""
    for candidate in ([override] if override else []) + [shutil.which("tesseract")]:
        if candidate and os.path.isfile(candidate):
            return candidate
    for candidate in TESSERACT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# Finding the grid
# ---------------------------------------------------------------------------

def _narrow_groups(flags, max_width):
    """Runs of True in `flags` no wider than max_width, as centre indices."""
    groups, i, n = [], 0, len(flags)
    while i < n:
        if not flags[i]:
            i += 1
            continue
        start = i
        while i < n and flags[i]:
            i += 1
        if i - start <= max_width:
            groups.append((start + i - 1) // 2)
    return groups


def _horizontal_rules(gray):
    """
    Row indices of the table's rules: the first tight run of thin lines.

    As with the vertical rules, a rule must sit against a row of white cells.
    Without that, a top or bottom border that meets a grey band above or below
    it merges into one thick run and is discarded as if it were the title bar.
    """
    height, width = gray.shape
    spans = (gray < NON_WHITE).sum(axis=1) >= WIDTH_FRACTION * width
    cell_row = (gray >= WHITE).sum(axis=1) >= CELL_ROW_FRACTION * width
    beside_cell = [
        spans[y] and ((y > 0 and cell_row[y - 1]) or (y < height - 1 and cell_row[y + 1]))
        for y in range(height)
    ]
    rules = _narrow_groups(beside_cell, MAX_RULE_THICKNESS)
    if not rules:
        return None

    cluster = [rules[0]]
    for y in rules[1:]:
        if y - cluster[-1] <= MAX_RULE_GAP:
            cluster.append(y)
        elif len(cluster) >= MIN_RULES:
            return cluster
        else:
            cluster = [y]
    return cluster if len(cluster) >= MIN_RULES else None


def _close_clipped_last_row(gray, rules):
    """
    Close off a last row whose bottom rule is not in the picture.

    The worksheet pane is often sized so that the sixth row is the last thing
    it shows, and the rule beneath it falls under the Geometry/Worksheet tab
    strip: the numbers are all there, but only seven of the eight rules are.
    So when white cells carry on below the last rule for most of a row's
    height, that band is the sixth row, and it is closed at one row's pitch
    below the rule -- or at the cut, whichever comes first.

    Returns the extended rules, or None when the rule missing is not the last
    one at all -- the rules are unevenly spaced then, and the caller should
    report the row count rather than blame the crop. Raises TableNotFound when
    it *is* the last row but the cut went through the digits, which would be
    read as some other number rather than not read at all.
    """
    height, width = gray.shape
    gaps = np.diff(rules)
    pitch = int(np.median(gaps))
    if pitch < 1 or gaps.max() > MAX_RULE_PITCH_DRIFT * pitch:
        return None

    cell_row = (gray >= WHITE).sum(axis=1) >= CELL_ROW_FRACTION * width
    y = rules[-1] + 1
    while y < height and cell_row[y]:
        y += 1
    y = min(y, rules[-1] + pitch)
    if y - rules[-1] - 1 < _readable_row_height():
        raise TableNotFound(
            f"the {SUBTYPES[-1]} row is cut off at the bottom of this image, so "
            "its numbers cannot be read -- re-take the screenshot with a little "
            "space below the table"
        )
    return rules + [y]


def _readable_row_height():
    """
    The shortest cell band the glyph matcher can still read exactly.

    A glyph box is blank for its last few rows, so a row cut off inside that
    blank margin loses nothing: the matcher pads the band back out and scores
    an identical match. Cut one row higher and the digits themselves are
    sliced, so the shapes no longer match and the cell falls to Tesseract --
    which, on a half-digit, answers 2.4 where the table said 20.264. Refusing
    is the better answer there, so this is where the recovery stops.
    """
    glyphs = _load_glyphs()
    inked = np.concatenate(list(glyphs.values()), axis=1).sum(axis=1)
    return int(np.max(np.nonzero(inked))) + 1


def _vertical_rules(gray, top, bottom):
    """
    Column indices of the grid's vertical rules, within the table's own band.

    A rule is a column carrying almost no white that sits right against a
    white cell. "Right against a cell" is what matters: the table's right
    border runs straight into the grey pane beyond it, so border and pane form
    one long white-free stretch, and judging by width alone would throw the
    border away with the pane. The image edges are excluded, since an edge has
    nothing beyond it for a rule to separate.
    """
    band = gray[top + 1:bottom]
    if band.shape[0] < 4:
        return []
    white = (band >= WHITE).sum(axis=0)
    sparse = white < COLUMN_WHITE_FRACTION * band.shape[0]
    cell = white > 0.5 * band.shape[0]
    width = len(white)
    beside_cell = [
        sparse[x] and ((x > 0 and cell[x - 1]) or (x < width - 1 and cell[x + 1]))
        for x in range(width)
    ]
    return [x for x in _narrow_groups(beside_cell, 3) if 1 < x < width - 2]


def find_grid(source):
    """
    Locate the table. Returns (image, h_rules, v_rules), rules as pixel positions.

    Raises TableNotFound with a reason, rather than returning a grid it is not
    sure about -- a wrong grid reads wrong numbers silently, which is the one
    outcome worth refusing.
    """
    image = Image.open(source).convert("RGB")
    gray = np.asarray(image.convert("L"))

    h_rules = _horizontal_rules(gray)
    if not h_rules:
        raise TableNotFound("no table grid found in this image")
    if len(h_rules) == EXPECTED_H_RULES - 1:
        h_rules = _close_clipped_last_row(gray, h_rules) or h_rules
    if len(h_rules) != EXPECTED_H_RULES:
        raise TableNotFound(
            f"found {len(h_rules) - 1} table rows, expected "
            f"{EXPECTED_H_RULES - 1} (a header row and {len(SUBTYPES)} data rows)"
        )

    v_rules = _vertical_rules(gray, h_rules[0], h_rules[-1])
    if len(v_rules) != EXPECTED_V_RULES:
        raise TableNotFound(
            f"found {max(len(v_rules) - 1, 0)} table columns, expected "
            f"{EXPECTED_V_RULES - 1} (a Subtype column and {len(COLUMNS)} value columns)"
        )

    return image, h_rules, v_rules


def crop_to_table(image, h_rules, pad=6):
    """
    Everything above the table's bottom rule, for showing what was read.

    The full width and the top of the screenshot come along, so the "SCL- N"
    label and the "Stress Units" line stay visible; the graph does not.
    """
    return image.crop((0, 0, image.width, min(image.height, h_rules[-1] + pad)))


# ---------------------------------------------------------------------------
# Reading the cells
# ---------------------------------------------------------------------------
#
# ANSYS draws every number in one screen font, Segoe UI 9pt, with no
# kerning: each digit is 6px wide, "." 3px, "-" 5px, "e" 6px, "+" 8px, and
# every "5" is pixel-for-pixel the same "5". So a cell is read by matching
# shapes, not by guessing: glyphs.json holds the ink map of each character,
# and a cell is decoded as the run of characters whose shapes, laid side by
# side, reproduce its pixels most closely.
#
# That replaced Tesseract as the reader because Tesseract guesses. On the
# SCL-1 screenshot it read 5.0275 as 9.0275 and 5.0026 as 3.0026; on a
# faithful re-rendering of the same table it got six cells wrong, most of them
# 5s. Shape matching reads that re-rendering 66/66, and a real screenshot
# 66/66 with a mismatch of exactly zero.
#
# The digits, "." and "-" in glyphs.json were cut from a real ANSYS
# screenshot; "e" and "+" (absent from it) were drawn by Windows in Segoe UI
# 9pt ClearType, the one font whose widths match the screenshot exactly.

GLYPHS_FILE = Path(__file__).with_name("glyphs.json")
# Mismatch is the leftover pixel error as a share of the cell's ink: 0 means
# identical. Genuine ANSYS text scores 0.00-0.10 (ClearType settings differ a
# little between machines); a different font scores above 0.4. Anything over
# the threshold is not trusted and goes to Tesseract, flagged for checking.
MATCH_THRESHOLD = 0.25
VERTICAL_SEARCH = 3       # rows up or down the text may sit from where it was measured
NUMBER = re.compile(r"-?\d+(\.\d*)?(e[+-]\d+)?$")

_glyphs = None


def _load_glyphs():
    global _glyphs
    if _glyphs is None:
        raw = json.loads(GLYPHS_FILE.read_text(encoding="utf-8"))
        _glyphs = {ch: np.array(rows, dtype=float) for ch, rows in raw.items()}
    return _glyphs


def _cell_ink(gray, h_rules, v_rules, row, column):
    """One cell as an ink map: 0 where the paper is white, 1 where it is black."""
    top, bottom = h_rules[row + 1] + 1, h_rules[row + 2]
    left, right = v_rules[column + 1] + 1, v_rules[column + 2]
    return 1.0 - gray[top:bottom, left:right].astype(float) / 255.0


def _decode(ink, glyphs):
    """
    The character string whose glyphs best reproduce this strip of ink.

    Dynamic programming across the columns: every column is either blank or
    the start of a glyph, and the cheapest way to explain the whole strip wins.
    It needs no gaps between characters, which matters -- ClearType smears
    neighbouring digits together, so "386" is one unbroken blot of ink.
    Returns (text, mismatch).
    """
    height, width = ink.shape
    blank = (ink ** 2).sum(axis=0)
    costs = {}
    for ch, shape in glyphs.items():
        w = shape.shape[1]
        if w <= width:
            windows = sliding_window_view(ink, (height, w))[0]
            costs[ch] = ((windows - shape) ** 2).sum(axis=(1, 2))

    best = np.full(width + 1, np.inf)
    best[0] = 0.0
    back = [None] * (width + 1)
    for x in range(width):
        so_far = best[x]
        if not np.isfinite(so_far):
            continue
        if so_far + blank[x] < best[x + 1]:
            best[x + 1], back[x + 1] = so_far + blank[x], (x, "")
        for ch, cost in costs.items():
            end = x + glyphs[ch].shape[1]
            if end <= width and so_far + cost[x] < best[end]:
                best[end], back[end] = so_far + cost[x], (x, ch)

    text, x = [], width
    while x > 0:
        x, ch = back[x]
        text.append(ch)
    return "".join(reversed(text)), best[width] / max((ink ** 2).sum(), 1e-6)


def _match_shapes(ink):
    """
    Decode a cell by glyph shape. Returns (value or None, mismatch).

    The text is tried a few rows up and down from where it was measured, so a
    screenshot framed a pixel differently still lines up.
    """
    glyphs = _load_glyphs()
    glyph_height = next(iter(glyphs.values())).shape[0]
    padded = np.pad(ink, ((VERTICAL_SEARCH, VERTICAL_SEARCH), (0, 0)))
    tries = [
        _decode(padded[dy:dy + glyph_height], glyphs)
        for dy in range(0, padded.shape[0] - glyph_height + 1)
    ]
    if not tries:
        return None, float("inf")
    text, mismatch = min(tries, key=lambda t: t[1])
    if not NUMBER.match(text):
        return None, mismatch
    return float(text), mismatch


def _tesseract_image(ink):
    """A cell prepared for Tesseract: upscaled and set in a white margin."""
    cell = Image.fromarray(((1.0 - ink) * 255).clip(0, 255).astype(np.uint8))
    cell = cell.resize((cell.width * UPSCALE, cell.height * UPSCALE), Image.LANCZOS)
    return ImageOps.expand(cell, border=OCR_MARGIN, fill=255)


def _to_number(text):
    """Tesseract's text as a float, or None if it isn't one."""
    text = text.strip().replace(" ", "")
    try:
        return float(text) if text else None
    except ValueError:
        return None


def read_cells(image, h_rules, v_rules, tesseract_cmd=None):
    """
    Read every cell of the found grid.

    Returns (rows, unreadable, uncertain):
      rows        6 lists of 11 values, each a float or None
      unreadable  (row, column, raw text) for cells with no number at all
      uncertain   (row, column, value) for cells whose shapes did not match the
                  ANSYS font closely, so Tesseract read them instead -- these
                  are the ones worth checking against the image

    Tesseract is only needed for the fallback. If it is not installed, a cell
    that needs it is left empty rather than guessed.
    """
    gray = np.asarray(image.convert("L"))
    binary = tesseract_cmd or find_tesseract()
    rows, unreadable, uncertain = [], [], []
    for i in range(len(SUBTYPES)):
        values = []
        for j in range(len(COLUMNS)):
            ink = _cell_ink(gray, h_rules, v_rules, i, j)
            value, mismatch = _match_shapes(ink)
            if value is not None and mismatch <= MATCH_THRESHOLD:
                values.append(value)
                continue

            raw, value = "", None
            if binary:
                import pytesseract
                pytesseract.pytesseract.tesseract_cmd = binary
                raw = pytesseract.image_to_string(_tesseract_image(ink), config=OCR_CONFIG).strip()
                value = _to_number(raw)
            if value is None:
                unreadable.append((i, j, raw))
            else:
                uncertain.append((i, j, value))
            values.append(value)
        rows.append(values)
    return rows, unreadable, uncertain


def read_table(source, tesseract_cmd=None):
    """Grid, crop and numbers in one call. Returns (crop, rows, unreadable, uncertain)."""
    image, h_rules, v_rules = find_grid(source)
    rows, unreadable, uncertain = read_cells(image, h_rules, v_rules, tesseract_cmd)
    return crop_to_table(image, h_rules), rows, unreadable, uncertain
