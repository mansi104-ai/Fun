"""
Finds the SCL results table in a screenshot and reads its numbers.

Classical computer vision only -- no model, no API key, nothing over the
network. The table is a drawn grid, so the cells are located geometrically
first; then each cell is read by matching its pixels against the shapes of
the ANSYS font's characters (see "Reading the cells" below).

The table may have any number of data rows and value columns. The first row
is taken as the header and the first column as the label column; everything
else is read as numbers.

Pixel facts the grid search keys on (from a real 968x823 screenshot):

    panel background   160    the grey around the table
    table rules        192    the 1px lines of the grid
    outer border       100
    cell background    255    white
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
MIN_RULES = 3             # header + at least one data row + closing rule
COLUMN_WHITE_FRACTION = 0.15
CELL_ROW_FRACTION = 0.30  # a row of cells is ~70% white; a rule row is ~0%
MAX_RULE_PITCH_DRIFT = 1.5  # a missing middle rule leaves a gap of ~2 pitches
CROSSED_FRACTION = 0.90   # share of a strip a horizontal rule must cover
RULE_ROW_FRACTION = 0.90  # share of vertical rules that must continue in a row

# Optional default labels. Used only when the grid's size matches; otherwise
# generic names are generated. Nothing is validated against them.
DEFAULT_COLUMNS = ["SX", "SY", "SZ", "SXY", "SYZ", "SXZ", "S1", "S2", "S3", "SINT", "SEQV"]
DEFAULT_SUBTYPES = [
    "Membrane", "Bending (Inside)", "Bending (Outside)",
    "Membrane+Bending (Inside)", "Membrane+Bending (Center)",
    "Membrane+Bending (Outside)",
]

OCR_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789.-e+"
UPSCALE = 6
OCR_MARGIN = 30

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


def column_names(count):
    return DEFAULT_COLUMNS if count == len(DEFAULT_COLUMNS) else [f"C{j + 1}" for j in range(count)]


def row_names(count):
    return DEFAULT_SUBTYPES if count == len(DEFAULT_SUBTYPES) else [f"R{i + 1}" for i in range(count)]


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
    """Row indices of the table's rules: the first tight run of thin lines."""
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


def _candidate_vertical_rules(gray, top, bottom):
    """
    Every full-height dark line that sits against white, inside the table's
    row band. This over-collects on purpose: it also picks up things like the
    window frame. _table_rules decides which of them belong to the table.
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


def _table_rules(gray, h_rules, candidates):
    """
    Keep only the vertical rules that belong to the table.

    A real column strip is crossed by every horizontal rule. White margin
    between the window frame and the table is not: it has vertical lines on
    both sides but nothing running across it. So each gap between neighbouring
    candidates is tested for being crossed, and the longest unbroken run of
    crossed gaps is the table.
    """
    if len(candidates) < 2:
        return []
    crossed = []
    for a, b in zip(candidates, candidates[1:]):
        strip = gray[:, a + 2:b - 1] if b - a > 4 else gray[:, a + 1:b]
        if strip.size == 0:
            crossed.append(False)
            continue
        hits = [(strip[y] < NON_WHITE).mean() >= CROSSED_FRACTION for y in h_rules]
        crossed.append(all(hits))

    best, start = (0, 0), None
    for i, ok in enumerate(crossed + [False]):
        if ok and start is None:
            start = i
        elif not ok and start is not None:
            if i - start > best[1] - best[0]:
                best = (start, i)
            start = None
    first, last = best
    return candidates[first:last + 1] if last > first else []


def _close_clipped_last_row(gray, h_rules, v_rules):
    """
    Handle a last row whose bottom rule is not in the picture.

    A row below the last rule only counts if the table's vertical rules keep
    running through it AND its cells are white -- that is what separates a
    clipped table row from the tab strip or plot beneath the table. Its height
    is capped at one row's pitch.

    Returns (h_rules, note). Raises TableNotFound if the cut went through the
    digits, since half a digit reads as a different number.
    """
    height = gray.shape[0]
    left, right = v_rules[0], v_rules[-1]
    pitch = int(np.median(np.diff(h_rules)))
    cells = (gray[:, left + 1:right] >= WHITE).mean(axis=1) >= CELL_ROW_FRACTION
    runs = np.array([(gray[:, max(x - 1, 0):x + 2].min(axis=1) < NON_WHITE) for x in v_rules])
    continues = runs.mean(axis=0) >= RULE_ROW_FRACTION

    y0 = h_rules[-1] + 1
    y = y0
    while y < height and y - y0 < pitch and cells[y] and continues[y]:
        y += 1
    band = y - y0
    if band <= 0:
        return h_rules, None

    if band >= _readable_row_height():
        return h_rules + [y], None

    has_ink = (gray[y0:y, left + 1:right] < 128).any()
    if has_ink:
        raise TableNotFound(
            "the last row is cut off at the bottom of this image, so its numbers "
            "cannot be read -- re-take the screenshot with a little space below the table"
        )
    return h_rules, (
        f"{band}px of an extra row show below the table with nothing readable in "
        "them; it was ignored"
    )


def _readable_row_height():
    """The shortest cell band the glyph matcher can still read exactly."""
    glyphs = _load_glyphs()
    inked = np.concatenate(list(glyphs.values()), axis=1).sum(axis=1)
    return int(np.max(np.nonzero(inked))) + 1


def find_grid(source):
    """
    Locate the table. Returns (image, h_rules, v_rules, notes).

    The table may have any number of rows and columns. Raises TableNotFound
    rather than returning a grid it is not sure about.
    """
    image = Image.open(source).convert("RGB")
    gray = np.asarray(image.convert("L"))
    notes = []

    h_rules = _horizontal_rules(gray)
    if not h_rules:
        raise TableNotFound("no table grid found in this image")

    gaps = np.diff(h_rules)
    pitch = float(np.median(gaps))
    if gaps.max() > MAX_RULE_PITCH_DRIFT * pitch:
        raise TableNotFound(
            "the table's horizontal rules are unevenly spaced (a rule may be missing "
            "or hidden), so rows cannot be told apart reliably"
        )

    candidates = _candidate_vertical_rules(gray, h_rules[0], h_rules[-1])
    v_rules = _table_rules(gray, h_rules, candidates)
    if len(v_rules) < 3:     # a label column and at least one value column
        raise TableNotFound(
            f"found {max(len(v_rules) - 1, 0)} table columns; need a label column "
            "and at least one value column"
        )

    h_rules, note = _close_clipped_last_row(gray, h_rules, v_rules)
    if note:
        notes.append(note)
    if len(h_rules) < 3:
        raise TableNotFound("found no data rows under the header row")

    return image, h_rules, v_rules, notes


def crop_to_table(image, h_rules, pad=6):
    """Everything above the table's bottom rule, for showing what was read."""
    return image.crop((0, 0, image.width, min(image.height, h_rules[-1] + pad)))


# ---------------------------------------------------------------------------
# Reading the cells
# ---------------------------------------------------------------------------
#
# ANSYS draws every number in one screen font, Segoe UI 9pt, with no kerning,
# so a cell is read by matching shapes: glyphs.json holds the ink map of each
# character, and a cell is decoded as the run of characters whose shapes, laid
# side by side, reproduce its pixels most closely. Tesseract is only the
# fallback for cells whose shapes don't match.

GLYPHS_FILE = Path(__file__).with_name("glyphs.json")
MATCH_THRESHOLD = 0.25
VERTICAL_SEARCH = 3
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
    """The character string whose glyphs best reproduce this strip of ink."""
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
    """Decode a cell by glyph shape. Returns (value or None, mismatch)."""
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
    cell = Image.fromarray(((1.0 - ink) * 255).clip(0, 255).astype(np.uint8))
    cell = cell.resize((cell.width * UPSCALE, cell.height * UPSCALE), Image.LANCZOS)
    return ImageOps.expand(cell, border=OCR_MARGIN, fill=255)


def _to_number(text):
    text = text.strip().replace(" ", "")
    try:
        return float(text) if text else None
    except ValueError:
        return None


def read_cells(image, h_rules, v_rules, tesseract_cmd=None):
    """
    Read every data cell of the found grid (header row and label column skipped).

    Returns (rows, unreadable, uncertain):
      rows        one list of floats/None per data row, any size
      unreadable  (row, column, raw text) for cells with no number at all
      uncertain   (row, column, value) for cells Tesseract had to read
    """
    gray = np.asarray(image.convert("L"))
    binary = tesseract_cmd or find_tesseract()
    n_rows, n_cols = len(h_rules) - 2, len(v_rules) - 2
    rows, unreadable, uncertain = [], [], []
    for i in range(n_rows):
        values = []
        for j in range(n_cols):
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
    """
    Grid, crop and numbers in one call.
    Returns (crop, rows, unreadable, uncertain, notes).
    """
    image, h_rules, v_rules, notes = find_grid(source)
    rows, unreadable, uncertain = read_cells(image, h_rules, v_rules, tesseract_cmd)
    return crop_to_table(image, h_rules), rows, unreadable, uncertain, notes