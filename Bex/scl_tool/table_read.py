"""
Finds the SCL results table in a screenshot and reads its 6 x 11 numbers.

Classical computer vision only -- no model, no API key, nothing over the
network. The whole approach rests on the table being a drawn grid, which it
is, so the cells can be located geometrically before a single character is
read.

Why that matters: reading these tables by pointing OCR at the whole image does
not work. Tried that way, Tesseract returned the Membrane row as '0273837205',
'21254-12686', '-2.9965' -- decimal points gone, two values merged into one
token -- and picked up the Geometry/Worksheet tab strip as extra rows. Reading
one *cell* at a time is a different problem: the box is known, it holds exactly
one number, and the only characters possible are digits and "-.e+". On a real
screenshot that reads 66 of 66 values exactly.

The pixel facts it keys on, measured from a real 968x823 screenshot:

    panel background   160    the grey around the table
    table rules        192    the 1px lines of the grid
    outer border       100
    cell background    255    white

so a rule is a line where the whole width is non-white, and a cell is white.
The graph never enters the picture: only the cells inside the found grid are
read, and the plot lies hundreds of pixels below the last of them.
"""

import os
import shutil

import numpy as np
from PIL import Image, ImageOps

NON_WHITE = 200           # grey 160 and rule 192 fall below it; cells (255) don't
WHITE = 240
WIDTH_FRACTION = 0.80     # a rule spans the pane; a row of numbers does not
MAX_RULE_THICKNESS = 4    # a thin line, not the filled title bar at the top
MAX_RULE_GAP = 40         # rules sit ~17px apart; the graph's lines are ~250px
MIN_RULES = 4
COLUMN_WHITE_FRACTION = 0.15
CELL_ROW_FRACTION = 0.30  # a row of cells is ~70% white; a rule row is ~0%

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

def _cell_image(gray, h_rules, v_rules, row, column):
    """
    One cell, prepared for OCR: upscaled, then set in a white margin.

    The raw ~47x16 box is below what Tesseract can handle, and it reads a line
    more reliably with space around it than with glyphs touching the edge.
    Measured on a real screenshot plus a synthetic one full of e-002 values,
    the margin took the synthetic from 65/66 to 66/66; binarizing made it worse.
    """
    top, bottom = h_rules[row + 1] + 1, h_rules[row + 2]
    left, right = v_rules[column + 1] + 1, v_rules[column + 2]
    cell = Image.fromarray(gray[top:bottom, left:right])
    cell = cell.resize((cell.width * UPSCALE, cell.height * UPSCALE), Image.LANCZOS)
    return ImageOps.expand(cell, border=OCR_MARGIN, fill=255)


def _to_number(text):
    """The cell's text as a float, or None if it isn't one."""
    text = text.strip().replace(" ", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def read_cells(image, h_rules, v_rules, tesseract_cmd=None):
    """
    Read every cell of the found grid.

    Returns (rows, unreadable) -- rows is 6 lists of 11 values, each a float or
    None, and unreadable lists (row, column, raw text) for the cells that did
    not come back as a number, so they can be pointed at rather than guessed.
    """
    import pytesseract

    binary = tesseract_cmd or find_tesseract()
    if not binary:
        raise TableNotFound(
            "Tesseract is not installed, or not where this tool looked. "
            "Install it from https://github.com/UB-Mannheim/tesseract/wiki "
            "and it will be found automatically."
        )
    pytesseract.pytesseract.tesseract_cmd = binary

    gray = np.asarray(image.convert("L"))
    rows, unreadable = [], []
    for i in range(len(SUBTYPES)):
        values = []
        for j in range(len(COLUMNS)):
            text = pytesseract.image_to_string(
                _cell_image(gray, h_rules, v_rules, i, j), config=OCR_CONFIG
            )
            value = _to_number(text)
            if value is None:
                unreadable.append((i, j, text.strip()))
            values.append(value)
        rows.append(values)
    return rows, unreadable


def read_table(source, tesseract_cmd=None):
    """Grid, crop and numbers in one call. Returns (crop, rows, unreadable)."""
    image, h_rules, v_rules = find_grid(source)
    rows, unreadable = read_cells(image, h_rules, v_rules, tesseract_cmd)
    return crop_to_table(image, h_rules), rows, unreadable
