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
import hashlib
from datetime import datetime

import openpyxl
from PIL import Image
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


def apply_tesseract_cmd(cfg):
    if cfg.get("tesseract_cmd"):
        pytesseract.pytesseract.tesseract_cmd = cfg["tesseract_cmd"]


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


def _extract_lines(image):
    """OCR the image and return a list of (label_guess, [numbers]) tuples,
    one per detected text line, in top-to-bottom reading order."""
    data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
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

    # Upscale the cropped table for better OCR accuracy on small text.
    scale = 3
    img_big = table_crop.resize((table_crop.width * scale, table_crop.height * scale), Image.LANCZOS)

    lines = _extract_lines(img_big)

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

def find_next_empty_block(ws):
    """
    Scan column A for pre-numbered SCL block starts, and column C to see
    whether that block's data is already filled. Returns the row number
    where the next empty 6-row block begins, or None if no pre-numbered
    block is free (in which case the caller should append a fresh block
    after the last used row).
    """
    max_row = ws.max_row
    row = 1
    last_block_start = None
    while row <= max_row:
        a_val = ws.cell(row=row, column=1).value
        if isinstance(a_val, (int, float)):
            last_block_start = row
            c_val = ws.cell(row=row, column=FIRST_DATA_COL).value
            if c_val in (None, ""):
                return row
        row += 1
    # No pre-numbered empty block found. Fall back to appending right
    # after the last known block.
    if last_block_start is not None:
        return last_block_start + BLOCK_STRIDE
    return 2  # empty sheet fallback (row 1 assumed header)


def write_block(ws, start_row, rows):
    for i, row_vals in enumerate(rows):
        r = start_row + i
        for j, val in enumerate(row_vals):
            col = FIRST_DATA_COL + j
            if val is not None:
                ws.cell(row=r, column=col, value=val)


def check_headers(ws):
    """Fuzzy-match C1:M1 against EXPECTED_HEADERS. Returns list of mismatch warnings."""
    warnings = []
    # A couple of these headers are commonly written with swapped letters
    # (e.g. "SZX" vs "SXZ") for the same shear component; treat as equivalent.
    synonyms = {"SXZ": {"SXZ", "SZX"}}

    for j, expected in enumerate(EXPECTED_HEADERS):
        col = FIRST_DATA_COL + j
        actual = ws.cell(row=1, column=col).value
        if actual is None:
            continue
        actual_u = str(actual).strip().upper()
        if actual_u in synonyms.get(expected, {expected}):
            continue
        if _norm(str(actual)) != _norm(expected):
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
    header_warnings = check_headers(ws)

    summary = {"processed": [], "skipped": [], "flagged": [], "header_warnings": header_warnings}

    for item in image_items:
        fname = item["name"]
        data = item["data"]
        fingerprint = compute_fingerprint(fname, data)

        if already_processed(wb, fingerprint):
            summary["skipped"].append(fname)
            continue

        result = extract_scl_table(data)

        if not result["ok"]:
            log_history(
                wb, fname, source_label, result.get("title"), ws.title,
                "-", "NEEDS REVIEW",
                "; ".join(result["warnings"]) or "Could not confidently read table.",
                fingerprint,
            )
            summary["flagged"].append((fname, result["warnings"]))
            continue

        start_row = find_next_empty_block(ws)
        end_row = start_row + ROWS_PER_BLOCK - 1
        write_block(ws, start_row, result["rows"])

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
