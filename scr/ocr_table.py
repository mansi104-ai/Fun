"""
Extracts tabular data from an image (e.g. a screenshot containing a grid table)
using OpenCV for table/grid detection and Tesseract for OCR of each cell.

Falls back to plain line-based OCR if no grid lines are detected.
"""
import cv2
import numpy as np
import pandas as pd
import pytesseract


def tesseract_ready():
    """
    Return the installed Tesseract version, or None if the binary is missing.

    pytesseract is a wrapper around a separate command-line program, so `pip
    install pytesseract` succeeding says nothing about whether OCR can run.
    Checking once up front turns a TesseractNotFoundError traceback thrown
    mid-OCR into something the page can explain.
    """
    try:
        return str(pytesseract.get_tesseract_version())
    except Exception:
        return None


def _ocr_cell(gray_img, x, y, w, h, pad=2):
    x0, y0 = max(x + pad, 0), max(y + pad, 0)
    x1, y1 = x + w - pad, y + h - pad
    if x1 <= x0 or y1 <= y0:
        return ""
    cell = gray_img[y0:y1, x0:x1]
    if cell.size == 0:
        return ""
    # upscale small cells for better OCR accuracy
    scale = 2
    cell = cv2.resize(cell, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    text = pytesseract.image_to_string(cell, config="--psm 7").strip()
    return text


def _group_into_rows(boxes, y_tolerance=10):
    boxes = sorted(boxes, key=lambda b: b[1])
    rows, current_row, last_y = [], [], None
    for b in boxes:
        if last_y is None or abs(b[1] - last_y) <= y_tolerance:
            current_row.append(b)
        else:
            rows.append(current_row)
            current_row = [b]
        last_y = b[1]
    if current_row:
        rows.append(current_row)
    return rows


def _fallback_ocr(img) -> pd.DataFrame:
    """No grid detected: OCR the whole image and split lines/whitespace."""
    text = pytesseract.image_to_string(img)
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    rows = [line.split() for line in lines]
    if not rows:
        return pd.DataFrame()
    max_cols = max(len(r) for r in rows)
    rows = [r + [""] * (max_cols - len(r)) for r in rows]
    return pd.DataFrame(rows)


def extract_table_from_image(image_path: str) -> pd.DataFrame:
    img = cv2.imread(image_path)
    if img is None:
        return pd.DataFrame()

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    thresh = cv2.adaptiveThreshold(
        ~gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -2
    )

    # detect horizontal lines
    h_size = max(thresh.shape[1] // 30, 1)
    h_struct = cv2.getStructuringElement(cv2.MORPH_RECT, (h_size, 1))
    horizontal = cv2.dilate(cv2.erode(thresh, h_struct), h_struct)

    # detect vertical lines
    v_size = max(thresh.shape[0] // 30, 1)
    v_struct = cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_size))
    vertical = cv2.dilate(cv2.erode(thresh, v_struct), v_struct)

    mask = cv2.add(horizontal, vertical)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes = [cv2.boundingRect(c) for c in contours]
    boxes = [b for b in boxes if b[2] > 15 and b[3] > 12]

    if len(boxes) < 4:
        return _fallback_ocr(img)

    row_groups = _group_into_rows(boxes)
    table_rows = []
    for row in row_groups:
        row = sorted(row, key=lambda b: b[0])
        texts = [_ocr_cell(gray, x, y, w, h) for (x, y, w, h) in row]
        table_rows.append(texts)

    if not table_rows:
        return _fallback_ocr(img)

    max_cols = max(len(r) for r in table_rows)
    table_rows = [r + [""] * (max_cols - len(r)) for r in table_rows]
    df = pd.DataFrame(table_rows)

    # promote first row to header if it looks like text labels (non-numeric)
    if len(df) > 1:
        first_row = df.iloc[0].astype(str)
        if first_row.str.contains(r"[A-Za-z]", regex=True).mean() > 0.5:
            df.columns = [c if c else f"col_{i}" for i, c in enumerate(first_row)]
            df = df.iloc[1:].reset_index(drop=True)

    return df
