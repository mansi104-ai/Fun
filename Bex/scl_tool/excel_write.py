"""
Writes extracted blocks into the workbook's first worksheet, in place,
starting at column C. Blocks can have any number of rows and columns.

Each block is placed one blank row below the last row holding anything in
column C or beyond (not the last row of the whole sheet). Columns A and B
are never touched.
"""

import math
import shutil
from datetime import datetime

import openpyxl

FIRST_COL = 3  # column C


def as_number(value):
    """Parse one cell into a float, or None if it isn't a finite number."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip().replace(",", "")
        text = text.replace("–", "-").replace("—", "-").replace("−", "-")
        try:
            number = float(text)
        except ValueError:
            return None
    return number if math.isfinite(number) else None


def next_block_row(worksheet):
    """One blank row below the last row with anything from column C onward; row 2 if empty."""
    last_col = max(worksheet.max_column, FIRST_COL)
    for row in range(worksheet.max_row, 1, -1):
        if any(worksheet.cell(row=row, column=c).value not in (None, "")
               for c in range(FIRST_COL, last_col + 1)):
            return row + 2
    return 2


def check_block(rows):
    """Return a reason the block can't be written, or None if it's good."""
    if not rows:
        return "block is empty"
    width = len(rows[0])
    if width == 0:
        return "row 1 is empty"
    for i, row in enumerate(rows, start=1):
        if len(row) != width:
            return f"row {i} has {len(row)} columns, expected {width}"
        missing = sum(1 for v in row if as_number(v) is None)
        if missing:
            return f"row {i} has {width - missing} of {width} numbers"
    return None


def back_up(excel_path):
    """Copy the workbook beside itself before the first write of a save."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = excel_path.with_name(f"{excel_path.stem}.backup-{stamp}{excel_path.suffix}")
    shutil.copy2(excel_path, backup)
    return backup


def append_blocks(excel_path, blocks, make_backup=True):
    """
    Append each block starting at column C of the first worksheet and save in place.

    `blocks` is a sequence of (name, rows), with rows of any size as long as
    it is rectangular and all numeric. Invalid blocks are skipped whole and
    reported. Returns (written, skipped, backup) where written is
    [(name, first_row, last_row, first_col, last_col)] and skipped is
    [(name, reason)].
    """
    good, skipped = [], []
    for name, rows in blocks:
        reason = check_block(rows)
        if reason:
            skipped.append((name, reason))
        else:
            good.append((name, [[as_number(v) for v in row] for row in rows]))

    if not good:
        return [], skipped, None

    backup = back_up(excel_path) if make_backup else None

    workbook = openpyxl.load_workbook(excel_path)
    worksheet = workbook[workbook.sheetnames[0]]

    written = []
    for name, rows in good:
        start = next_block_row(worksheet)
        for i, values in enumerate(rows):
            for j, value in enumerate(values):
                cell = worksheet.cell(row=start + i, column=FIRST_COL + j, value=value)
                cell.number_format = "General"
        written.append((name, start, start + len(rows) - 1,
                        FIRST_COL, FIRST_COL + len(rows[0]) - 1))

    workbook.save(excel_path)
    return written, skipped, backup


def describe_target(excel_path):
    """(sheet name, next row a block would land on) for the first worksheet."""
    workbook = openpyxl.load_workbook(excel_path, read_only=False)
    worksheet = workbook[workbook.sheetnames[0]]
    return worksheet.title, next_block_row(worksheet)