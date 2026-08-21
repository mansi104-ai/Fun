"""
scl_core.py
Core logic for extracting SCL (Stress Classification Line) result tables
from screenshot images and writing them into the fixed C:M columns of a
reference Excel workbook.

This module is deliberately dependency-light (openpyxl + pytesseract + Pillow)
so it runs on a plain local Python install.
"""

import os
import io
import re
import json
import math
import shutil
import hashlib
from datetime import datetime

import openpyxl
from PIL import Image, ImageOps
import pytesseract

# ---------------------------------------------------------------------------
# Fixed layout definitions (matches the reference workbook's C:M columns)
# ---------------------------------------------------------------------------

# Column headers expected in C1:M1 of the reference sheet, in order.
EXPECTED_HEADERS = ["SX", "SY", "SZ", "SXY", "SYZ", "SXZ", "S1", "S2", "S3", "SINT", "SEQV"]

# The 6 SCL subtype rows, in the fixed order they appear both in the
# screenshot table and in each 6-row block of the reference workbook.
SUBTYPE_ORDER = [
    "Membrane",
    "Bending (Inside)",
    "Bending (Outside)",
    "Membrane+Bending (Inside)",
    "Membrane+Bending (Center)",
    "Membrane+Bending (Outside)",
]

# Normalized (no spaces/parens, lowercase) versions used for fuzzy label matching.
def _norm(s):
    return re.sub(r"[^a-z0-9+]", "", s.lower())

SUBTYPE_NORM = [_norm(s) for s in SUBTYPE_ORDER]

FIRST_DATA_COL = 3   # column C
LAST_DATA_COL = 13   # column M
ROWS_PER_BLOCK = 6
BLOCK_STRIDE = 7      # 6 data rows + 1 blank spacer row

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}

NUMBER_RE = re.compile(r"^-?\d+\.?\d*$")


# ---------------------------------------------------------------------------
# Config handling
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "image_folder": "",
    "excel_path": "",
    "tesseract_cmd": "",   # optional override, e.g. Windows install path
}


def load_config(config_path):
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        merged = dict(DEFAULT_CONFIG)
        merged.update(cfg)
        return merged
    return dict(DEFAULT_CONFIG)


def save_config(config_path, cfg):
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


# Where the Windows installer puts Tesseract. It does not add itself to PATH by
# default, so an otherwise correct install is invisible to pytesseract, and the
# failure reads as a generic "tesseract is not installed" that sends you off
# reinstalling something you already have.
TESSERACT_FALLBACKS = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
    "/opt/homebrew/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/usr/bin/tesseract",
]


def resolve_tesseract(explicit=""):
    """
    Point pytesseract at a real tesseract binary, and report which one.

    Order: an explicit override, then PATH, then the usual install locations.
    Returns the path in use, or "" if nothing was found -- callers should say
    so plainly rather than letting the first image fail with a stack trace.
    """
    if explicit and os.path.isfile(explicit):
        pytesseract.pytesseract.tesseract_cmd = explicit
        return explicit

    found = shutil.which("tesseract")
    if found:
        pytesseract.pytesseract.tesseract_cmd = found
        return found

    for path in TESSERACT_FALLBACKS:
        if path and os.path.isfile(path):
            pytesseract.pytesseract.tesseract_cmd = path
            return path

    return ""


def apply_tesseract_cmd(cfg):
    return resolve_tesseract(cfg.get("tesseract_cmd", ""))


# ---------------------------------------------------------------------------
# Image -> table extraction
# ---------------------------------------------------------------------------

def _file_hash(path):
    """Cheap fingerprint (size+mtime) used to detect already-processed files
    even if they get renamed slightly, plus the filename itself."""
    stat = os.stat(path)
    return f"{stat.st_size}-{int(stat.st_mtime)}"


def compute_fingerprint(name, data: bytes) -> str:
    """Content-based fingerprint for in-memory (e.g. uploaded) files."""
    return f"{name}:{len(data)}-{hashlib.md5(data).hexdigest()[:10]}"


def _clean_number(tok):
    tok = tok.strip()
    try:
        return float(tok)
    except ValueError:
        pass

    # Strip stray OCR artifacts glued onto an otherwise valid number, e.g.
    # a misread grid line producing "/-1.0416" or a trailing "|".
    stripped = re.sub(r"^[^\-0-9.]+", "", tok)
    stripped = re.sub(r"[^0-9.]+$", "", stripped)

    if stripped.count(".") > 1:
        # e.g. "145.34." -> "145.34"
        stripped = stripped.rstrip(".")

    try:
        return float(stripped)
    except ValueError:
        return None


def _prepare_for_ocr(image, scale=3, threshold=100):
    """
    Flatten a table screenshot to black text on white, then upscale it.

    The thresholding is not cosmetic. The cell borders in these worksheets are
    light grey, and Tesseract's layout analysis treats them as structure: with
    the lines present it reads *zero* complete data rows out of a clean
    screenshot, because it fragments each row into separate regions. Dropping
    everything lighter than `threshold` deletes the grid and leaves the text,
    after which every row reads. Measured on a rendered reference table:
    0/6 rows with the grid, 6/6 without, at every scale tried.

    Threshold before resizing -- LANCZOS on a binary image keeps the strokes
    crisp, whereas resizing first and thresholding after reintroduces the grey
    edges this is meant to remove.
    """
    gray = image.convert("L")

    # A dark-themed capture would otherwise threshold to a solid black block.
    if sum(gray.getdata()) / float(gray.width * gray.height) < 128:
        gray = ImageOps.invert(gray)

    bw = gray.point(lambda p: 0 if p < threshold else 255)
    return bw.resize((bw.width * scale, bw.height * scale), Image.LANCZOS)


def _extract_lines(image, psm=6):
    """OCR the image and return a list of (label_guess, [numbers]) tuples,
    one per detected text line, in top-to-bottom reading order.

    PSM 6 -- "a single uniform block of text" -- is the mode that suits a data
    table. The default (3, fully automatic) tries to find page structure and
    reads these tables badly even after the grid is removed."""
    data = pytesseract.image_to_data(
        image, output_type=pytesseract.Output.DICT, config=f"--psm {psm}"
    )
    n = len(data["text"])
    lines = {}
    tops = {}
    for i in range(n):
        tok = data["text"][i].strip()
        if not tok:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append((data["left"][i], tok))
        tops.setdefault(key, data["top"][i])

    ordered_keys = sorted(lines.keys(), key=lambda k: tops[k])

    results = []
    for k in ordered_keys:
        toks = [t for _, t in sorted(lines[k])]
        label_parts = []
        numbers = []
        for t in toks:
            if t == "|":
                continue
            num = _clean_number(t)
            if num is not None:
                numbers.append(num)
            else:
                # only count as part of the label if we haven't hit numbers yet
                if not numbers:
                    label_parts.append(t)
        label = " ".join(label_parts)
        results.append((label, numbers))
    return results


# Constraining Tesseract to the characters a stress value can contain removes
# a whole class of error: "8" read as "B", "0" as "O", "1" as "l".
NUMERIC_WHITELIST = "0123456789.-"

# Light enough to include the grey rules as well as the black text, so both
# show up in the projections used to locate the grid.
GRID_DARK_THRESHOLD = 200


def _line_positions(counts, span, min_ratio=0.6):
    """
    Given a per-pixel count of dark pixels along one axis, return the centre of
    each run that spans most of the other axis -- i.e. each ruled line. Text
    never spans 60% of a row or column, so only real rules survive.
    """
    hits = [i for i, c in enumerate(counts) if c >= span * min_ratio]
    lines, run = [], []
    for i in hits:
        if run and i == run[-1] + 1:
            run.append(i)
        else:
            if run:
                lines.append(sum(run) // len(run))
            run = [i]
    if run:
        lines.append(sum(run) // len(run))
    return lines


def _detect_grid(image):
    """Pixel positions of the table's ruled lines, as (horizontal, vertical)."""
    gray = image.convert("L")
    if sum(gray.getdata()) / float(gray.width * gray.height) < 128:
        gray = ImageOps.invert(gray)
    bw = gray.point(lambda p: 0 if p < GRID_DARK_THRESHOLD else 255)

    w, h = bw.size
    px = bw.load()
    row_counts = [sum(1 for x in range(w) if px[x, y] == 0) for y in range(h)]
    col_counts = [sum(1 for y in range(h) if px[x, y] == 0) for x in range(w)]
    return _line_positions(row_counts, w), _line_positions(col_counts, h)


def _ocr_text(image, psm=7, whitelist=None):
    config = f"--psm {psm}"
    if whitelist:
        config += f" -c tessedit_char_whitelist={whitelist}"
    return pytesseract.image_to_string(image, config=config).strip()


def _trim_to_content(cell, pad=4):
    """
    Trim a cell down to its ink, then re-pad evenly.

    Cell edges come from the ruled lines, so the crop margin that keeps a rule
    out of the picture can just as easily clip a value sitting tight against
    it -- a leading minus sign is one stroke wide and is the first thing lost,
    which silently turns a compressive stress into a tensile one. Trimming to
    the glyphs and re-padding makes what Tesseract sees independent of exactly
    where the cell boundary landed.
    """
    gray = cell.convert("L")
    ink = gray.point(lambda p: 255 if p < 160 else 0)
    bbox = ink.getbbox()
    if not bbox:
        return cell
    return ImageOps.expand(cell.crop(bbox), border=pad, fill="white")


def _ocr_cells_as_line(cells, gap=40, scale=2):
    """
    Read a row of cells in one pass by re-laying them onto a blank canvas with
    wide gaps between them.

    Cropping to cells is what makes the values reliable; pasting them back with
    generous whitespace is what keeps it fast. One Tesseract call per row reads
    a reference table in about 2 seconds where one call per cell takes 15, and
    both get all 66 values right. The wide gap is the trick -- it guarantees
    Tesseract sees eleven separate words and cannot run two numbers together.
    """
    cells = [_trim_to_content(c) for c in cells]
    cw = max(c.width for c in cells)
    ch = max(c.height for c in cells)
    canvas = Image.new("RGB", (len(cells) * (cw + gap) + gap, ch + 2 * gap), "white")
    for i, cell in enumerate(cells):
        canvas.paste(cell, (gap + i * (cw + gap), gap))
    canvas = canvas.resize((canvas.width * scale, canvas.height * scale), Image.LANCZOS)
    return [_clean_number(t) for t in _ocr_text(canvas, 7, NUMERIC_WHITELIST).split()]


def _ocr_single_cell(cell, border=6, scale=3):
    padded = ImageOps.expand(_trim_to_content(cell), border=border, fill="white")
    padded = padded.resize((padded.width * scale, padded.height * scale), Image.LANCZOS)
    return _clean_number(_ocr_text(padded, 7, NUMERIC_WHITELIST))


def _extract_by_grid(table_img):
    """
    Cut the table on its own ruled lines and read the data cells.

    Returns (rows, labels), or None when no grid that could be this table was
    found -- the caller then falls back to reading the block as text.
    """
    n_cols = len(EXPECTED_HEADERS)
    h_lines, v_lines = _detect_grid(table_img)

    # 6 data rows plus a header need 8 horizontal rules; 11 data columns plus
    # the Subtype column need 13 vertical ones.
    if len(h_lines) < ROWS_PER_BLOCK + 2 or len(v_lines) < n_cols + 2:
        return None

    # Count from the end. The data rows are the last 6 bands and the data
    # columns the last 11, so this skips the header row and the Subtype column
    # while tolerating extra rules found above or left of the table.
    row_edges = h_lines[-(ROWS_PER_BLOCK + 1):]
    col_edges = v_lines[-(n_cols + 1):]
    label_left = v_lines[-(n_cols + 2)]

    rows, labels = [], []
    for r in range(ROWS_PER_BLOCK):
        top, bottom = row_edges[r] + 1, row_edges[r + 1] - 1
        if bottom - top < 4:
            return None  # bands too thin to be real rows

        cells = [
            table_img.crop((col_edges[c] + 2, top, col_edges[c + 1] - 1, bottom))
            for c in range(n_cols)
        ]

        values = _ocr_cells_as_line(cells)
        if len(values) != n_cols or any(v is None for v in values):
            # The fast path lost or merged something. Re-read this row one cell
            # at a time, which cannot confuse neighbours, and pay the seconds
            # only on the rows that need it.
            values = [_ocr_single_cell(c) for c in cells]

        rows.append(values[:n_cols])
        labels.append(_ocr_text(table_img.crop((label_left + 2, top, col_edges[0] - 1, bottom)), psm=7))

    return rows, labels


def _find_table_bottom(img):
    """
    Locate the y-pixel where the data table ends, using the 'Geometry' /
    'Worksheet' tab row that ANSYS-style SCL screenshots show just below
    the table (as in the reference screenshot). Falls back to the top 30%
    of the image if those tabs aren't detected.
    """
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    candidates = []
    for i in range(len(data["text"])):
        t = data["text"][i].strip().lower()
        if t in ("geometry", "worksheet", "graph"):
            candidates.append(data["top"][i])
    if candidates:
        return min(candidates)
    return int(img.height * 0.30)


def extract_scl_table(image_source):
    """
    Extract the 6x11 SCL data block from a screenshot image.

    image_source may be a file path (str) or raw image bytes.

    Returns a dict:
      {
        "ok": bool,
        "rows": [[11 floats], ...] (6 rows, only if ok),
        "title": str or None,          # e.g. "SCL- 10" if detected
        "warnings": [str, ...],
      }
    """
    warnings = []
    if isinstance(image_source, (bytes, bytearray)):
        img = Image.open(io.BytesIO(image_source))
    else:
        img = Image.open(image_source)
    if img.mode != "RGB":
        img = img.convert("RGB")

    # First pass at native resolution: find where the table region ends,
    # so we can crop it out and upscale just that part for accurate OCR
    # (the full image, including the chart below, is too dense to OCR well).
    table_bottom = _find_table_bottom(img)
    table_crop = img.crop((0, 0, img.width, min(table_bottom, img.height)))

    # Try to grab a title like "SCL- 10" from the title bar (top-left strip).
    title = None
    try:
        title_crop = img.crop((0, 0, min(300, img.width), min(25, img.height)))
        title_big = title_crop.resize((title_crop.width * 4, title_crop.height * 4), Image.LANCZOS)
        title_text = pytesseract.image_to_string(title_big, config="--psm 7")
        m = re.search(r"SCL\W*\d+", title_text, re.IGNORECASE)
        if m:
            title = m.group(0)
    except Exception:
        pass

    # Preferred path: use the table's own ruled lines to cut it into cells and
    # read each cell in isolation. Measured against a reference table, this
    # reads 66 of 66 values correctly where reading the table as running text
    # manages 53 -- neighbouring numbers merge or split otherwise, and "142.48"
    # arriving as "142" and "48" shifts every value in the row.
    chosen = None
    grid = _extract_by_grid(table_crop)
    if grid is not None:
        rows_raw, labels = grid
        chosen = list(zip(labels, rows_raw))

    if chosen is None:
        # No usable grid (an unruled table, or a heavily compressed capture).
        # Fall back to reading the whole block as text and hope the row
        # structure survives; validate_rows is the backstop either way.
        warnings.append("No table grid found; read the table as text instead, which is less reliable.")
        img_big = _prepare_for_ocr(table_crop, scale=3)
        lines = _extract_lines(img_big)

        # Candidate data rows: any OCR line with at least 9 numeric tokens
        # (allowing for a couple of missed reads).
        candidates = [(label, nums) for label, nums in lines if len(nums) >= 9]

        if len(candidates) < ROWS_PER_BLOCK:
            warnings.append(
                f"Only found {len(candidates)} data-like rows (need {ROWS_PER_BLOCK})."
            )
            return {"ok": False, "rows": None, "title": title, "warnings": warnings}

        # If there are more than 6 candidates, keep the first 6 in reading order
        # (the table's 6 rows always come first/together in these screenshots).
        chosen = candidates[:ROWS_PER_BLOCK]

    rows = []
    for idx, (label, nums) in enumerate(chosen):
        if len(nums) < LAST_DATA_COL - FIRST_DATA_COL + 1:
            warnings.append(
                f"Row {idx+1} ('{label or SUBTYPE_ORDER[idx]}') only has {len(nums)} numbers, expected 11."
            )
        row_vals = nums[:11]
        while len(row_vals) < 11:
            row_vals.append(None)
        rows.append(row_vals)

        # soft label cross-check
        norm_label = _norm(label)
        expected_norm = SUBTYPE_NORM[idx]
        if norm_label and expected_norm not in norm_label and norm_label not in expected_norm:
            warnings.append(
                f"Row {idx+1} label read as '{label}', expected something like '{SUBTYPE_ORDER[idx]}'."
            )

    ok = all(all(v is not None for v in r) for r in rows) and len(warnings) == 0
    # Even with warnings we still return rows so the caller can decide,
    # but ok=False if any value failed to parse at all.
    hard_fail = any(any(v is None for v in r) for r in rows)

    return {
        "ok": not hard_fail,
        "rows": rows,
        "title": title,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Excel writing
# ---------------------------------------------------------------------------

# A few of these headers are commonly written with the shear subscripts
# swapped ("SZX" vs "SXZ") for the same component; treat those as equivalent
# rather than reporting a layout mismatch.
HEADER_SYNONYMS = {
    "SXY": {"SXY", "SYX"},
    "SYZ": {"SYZ", "SZY"},
    "SXZ": {"SXZ", "SZX"},
}


def header_matches(actual, expected):
    if actual is None:
        return False
    a = _norm(str(actual))
    return any(a == _norm(v) for v in HEADER_SYNONYMS.get(expected, {expected}))


def detect_first_data_col(ws, max_scan_col=40):
    """
    Find where the SX..SEQV run actually starts in row 1, instead of assuming
    it begins at column C.

    Returns the 1-based column index of the SX header when all 11 headers are
    present, in order and adjacent; otherwise None, and the caller falls back
    to the documented C:M. Requiring the whole run to match is what keeps this
    safe: a partial or coincidental hit never redirects a write, so the worst
    case is the original hardcoded behaviour rather than 11 numbers landing in
    the wrong columns.
    """
    for start in range(1, max_scan_col + 1):
        if all(
            header_matches(ws.cell(row=1, column=start + j).value, h)
            for j, h in enumerate(EXPECTED_HEADERS)
        ):
            return start
    return None


def find_append_row(ws, first_col=FIRST_DATA_COL):
    """
    Row where the next 6-row block starts: one blank spacer row below the last
    row that has anything in the data columns.

    Only the 11 data columns decide what counts as occupied. Labels, block
    numbers or notes parked in column A would otherwise make the sheet look
    full far below the actual data and push every new block into empty space.

    An otherwise empty sheet starts at row 2, directly under the header --
    the blank row separates one block from the next, not the header from the
    first block.
    """
    last_col = first_col + len(EXPECTED_HEADERS) - 1
    for row in range(ws.max_row, 1, -1):
        if any(
            ws.cell(row=row, column=c).value not in (None, "")
            for c in range(first_col, last_col + 1)
        ):
            return row + 2
    return 2


def validate_rows(rows, rel_tol=1e-4):
    """
    Cross-check a freshly OCR'd block against identities that stress
    linearization guarantees, and that hold in every correct SCL table:

      1. Membrane == Membrane+Bending (Center). Linearized bending is zero at
         the mid-surface, so the centre row is the membrane row.
      2. Bending (Inside) == -Bending (Outside) for SX..SXZ. Linearized
         bending is antisymmetric about the mid-surface.
      3. For those two rows S1/S2/S3 reverse and negate, since negating a
         stress tensor negates its principals and flips their ordering.
      4. SINT and SEQV are identical for those two rows -- both are invariants
         unchanged by negating the tensor.

    These are properties of the maths, not of one workbook, so a violation
    means a digit was misread rather than that the model is unusual. Returns a
    list of human-readable failures; empty means the block is self-consistent.

    This is the strongest check available here: OCR errors that survive the
    layout parsing are exactly the ones that break these relationships.

    On the tolerance. ANSYS prints these to 5 significant figures and computes
    each row independently, so two values that are equal in theory can differ
    by one unit in the last printed place (~3e-5 relative). rel_tol=1e-4 sits
    just above that: it passes genuine rounding and catches a misread digit
    anywhere else, e.g. 335.51 read as 335.61 (3e-4).

    The gap that leaves is a misread of the *final* digit -- 335.51 as 335.52.
    That is mathematically indistinguishable from rounding here, and at 0.003%
    it does not change any engineering conclusion, so it is accepted rather
    than guessed at.
    """
    problems = []

    def close(a, b):
        if a is None or b is None:
            return False
        return math.isclose(a, b, rel_tol=rel_tol, abs_tol=1e-9)

    if len(rows) != ROWS_PER_BLOCK or any(len(r) != len(EXPECTED_HEADERS) for r in rows):
        return ["Block is not 6 rows x 11 columns."]

    membrane, bend_in, bend_out, _mb_in, mb_centre, _mb_out = rows

    for j, (a, b) in enumerate(zip(membrane, mb_centre)):
        if not close(a, b):
            problems.append(
                f"{EXPECTED_HEADERS[j]}: Membrane ({a}) should equal "
                f"Membrane+Bending (Center) ({b})."
            )

    for j in range(6):
        if not close(bend_in[j], -bend_out[j] if bend_out[j] is not None else None):
            problems.append(
                f"{EXPECTED_HEADERS[j]}: Bending (Inside) ({bend_in[j]}) should be "
                f"the negative of Bending (Outside) ({bend_out[j]})."
            )

    # S1,S2,S3 sit at indices 6,7,8 and mirror as (S1,S2,S3) -> (-S3,-S2,-S1).
    for j, k in ((6, 8), (7, 7), (8, 6)):
        if not close(bend_in[j], -bend_out[k] if bend_out[k] is not None else None):
            problems.append(
                f"{EXPECTED_HEADERS[j]}: Bending (Inside) ({bend_in[j]}) should be "
                f"the negative of Bending (Outside) {EXPECTED_HEADERS[k]} ({bend_out[k]})."
            )

    for j in (9, 10):
        if not close(bend_in[j], bend_out[j]):
            problems.append(
                f"{EXPECTED_HEADERS[j]}: Bending (Inside) ({bend_in[j]}) and "
                f"Bending (Outside) ({bend_out[j]}) should be identical."
            )

    return problems


def write_block(ws, start_row, rows, first_col=FIRST_DATA_COL):
    for i, row_vals in enumerate(rows):
        r = start_row + i
        for j, val in enumerate(row_vals):
            col = first_col + j
            if val is not None:
                ws.cell(row=r, column=col, value=val)


def check_headers(ws, first_col=FIRST_DATA_COL):
    """Fuzzy-match the 11 header cells against EXPECTED_HEADERS. Returns list of mismatch warnings."""
    warnings = []
    for j, expected in enumerate(EXPECTED_HEADERS):
        col = first_col + j
        actual = ws.cell(row=1, column=col).value
        if actual is None:
            continue
        if not header_matches(actual, expected):
            warnings.append(
                f"Column {openpyxl.utils.get_column_letter(col)}1 header is '{actual}', expected '{expected}'."
            )
    return warnings


# ---------------------------------------------------------------------------
# History sheet
# ---------------------------------------------------------------------------

HISTORY_SHEET_NAME = "Processing_History"
HISTORY_HEADERS = [
    "Timestamp", "Image File", "Source Folder", "SCL Title (detected)",
    "Target Sheet", "Rows Written", "Status", "Notes",
]


def ensure_history_sheet(wb):
    if HISTORY_SHEET_NAME in wb.sheetnames:
        return wb[HISTORY_SHEET_NAME]
    ws = wb.create_sheet(HISTORY_SHEET_NAME)
    ws.append(HISTORY_HEADERS)
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    return ws


def already_processed(wb, fingerprint):
    if HISTORY_SHEET_NAME not in wb.sheetnames:
        return False
    ws = wb[HISTORY_SHEET_NAME]
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row and len(row) >= 8 and row[7] and fingerprint in str(row[7]):
            if row[6] == "OK":
                return True
    return False


def log_history(wb, image_name, folder, title, sheet_name, rows_range, status, notes, fingerprint):
    ws = ensure_history_sheet(wb)
    ws.append([
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        image_name,
        folder,
        title or "",
        sheet_name,
        rows_range,
        status,
        f"{notes} [fp:{fingerprint}]".strip(),
    ])


# ---------------------------------------------------------------------------
# Main processing routine
# ---------------------------------------------------------------------------

def process_workbook(wb, image_items, source_label=""):
    """
    Core processing loop, decoupled from disk I/O so it can be reused for
    both a local folder (CLI) and in-memory uploads (Streamlit).

    wb: an already-open openpyxl Workbook.
    image_items: list of dicts, each {"name": str, "data": bytes}.
    source_label: free-text string logged as the "Source Folder" column
                  (e.g. a folder path, or "Uploaded").

    Returns a summary dict and mutates wb in place (caller is responsible
    for saving it).
    """
    ws = wb[wb.sheetnames[0]]  # first worksheet only

    # Prefer the columns the sheet's own headers point at; fall back to the
    # documented C:M when they cannot be identified with certainty.
    first_col = detect_first_data_col(ws)
    if first_col is None:
        first_col = FIRST_DATA_COL
    header_warnings = check_headers(ws, first_col)
    if first_col != FIRST_DATA_COL:
        header_warnings.append(
            "Headers SX..SEQV were found starting at column "
            f"{openpyxl.utils.get_column_letter(first_col)}, not C. Writing there instead."
        )

    summary = {"processed": [], "skipped": [], "flagged": [], "header_warnings": header_warnings}

    for item in image_items:
        fname = item["name"]
        data = item["data"]
        fingerprint = compute_fingerprint(fname, data)

        if already_processed(wb, fingerprint):
            summary["skipped"].append(fname)
            continue

        result = extract_scl_table(data)

        if result["ok"]:
            # A table that read cleanly can still have a misread digit. The
            # linearization identities catch those; a failure here means the
            # numbers are wrong, not merely suspicious.
            integrity = validate_rows(result["rows"])
            if integrity:
                result = dict(result, ok=False, warnings=result["warnings"] + integrity)

        if not result["ok"]:
            log_history(
                wb, fname, source_label, result.get("title"), ws.title,
                "-", "NEEDS REVIEW",
                "; ".join(result["warnings"]) or "Could not confidently read table.",
                fingerprint,
            )
            summary["flagged"].append((fname, result["warnings"]))
            continue

        start_row = find_append_row(ws, first_col)
        end_row = start_row + ROWS_PER_BLOCK - 1
        write_block(ws, start_row, result["rows"], first_col)

        notes = "; ".join(result["warnings"]) if result["warnings"] else "Clean read."
        log_history(
            wb, fname, source_label, result.get("title"), ws.title,
            f"{start_row}-{end_row}", "OK", notes, fingerprint,
        )
        summary["processed"].append((fname, start_row, end_row))

    return summary


def process_folder(cfg):
    """
    Process every new image in cfg['image_folder'], writing extracted data
    into cfg['excel_path'] (first worksheet only), and logging results to
    the Processing_History sheet. Returns a summary dict. (CLI entry point.)
    """
    apply_tesseract_cmd(cfg)

    folder = cfg["image_folder"]
    excel_path = cfg["excel_path"]

    if not folder or not os.path.isdir(folder):
        raise FileNotFoundError(f"Image folder not found: {folder}")
    if not excel_path or not os.path.isfile(excel_path):
        raise FileNotFoundError(f"Excel file not found: {excel_path}")

    wb = openpyxl.load_workbook(excel_path)

    files = sorted(
        f for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS
    )
    image_items = []
    for fname in files:
        with open(os.path.join(folder, fname), "rb") as f:
            image_items.append({"name": fname, "data": f.read()})

    summary = process_workbook(wb, image_items, source_label=folder)
    wb.save(excel_path)
    return summary
