import os
import json
from datetime import datetime
from pathlib import Path

import openpyxl
import pandas as pd
import streamlit as st

from ocr_table import extract_table_from_image, model_ready

# ---------------------------------------------------------------------------
# Persistent storage (plain files on disk next to this script -> survives
# app restarts / new browser sessions, no login/auth involved).
# ---------------------------------------------------------------------------
APP_DIR = Path(__file__).parent
# On a host with a real disk attached (see fly.toml), SCL_DATA_DIR points at
# the mounted volume so uploads outlive restarts and redeploys. Unset -- running
# locally, or on Streamlit Community Cloud -- it falls back to a folder beside
# this file, exactly as before.
DATA_DIR = Path(os.environ.get("SCL_DATA_DIR") or (APP_DIR / "app_data"))
IMAGES_DIR = DATA_DIR / "images"
EXCEL_DIR = DATA_DIR / "excel"
LOG_FILE = DATA_DIR / "processed_log.json"
# Fixed output layout: 11 values per row, written to columns C..M of the first
# worksheet, six rows per image, one blank row between images.
FIRST_DATA_COL = 3          # column C
DATA_COL_COUNT = 11         # C..M inclusive
ROWS_PER_IMAGE = 6
META_COLS = ["Source Image", "Extracted At"]

for d in (IMAGES_DIR, EXCEL_DIR):
    d.mkdir(parents=True, exist_ok=True)


def load_log() -> dict:
    if LOG_FILE.exists():
        return json.loads(LOG_FILE.read_text())
    return {"processed_images": []}


def save_log(log: dict) -> None:
    LOG_FILE.write_text(json.dumps(log, indent=2))


# ---------------------------------------------------------------------------
# Writing into the workbook, in the fixed C:M layout
# ---------------------------------------------------------------------------

def as_number(value):
    """Parse one OCR'd cell into a float, or None if it isn't a number."""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    # OCR reads a leading minus as a dash or en-dash often enough to be worth
    # normalising rather than losing the sign.
    text = text.replace("–", "-").replace("—", "-").replace("−", "-")
    try:
        return float(text)
    except ValueError:
        return None


def row_values(row):
    """
    Reduce one extracted row to its 11 numbers.

    Anything non-numeric is dropped, which removes the row-label column
    ("Membrane", "Bending (Inside)", ...) without needing to know which column
    it landed in. If more than 11 numbers survive, the last 11 win -- a stray
    number read out of the label column would appear at the front.
    """
    numbers = [n for n in (as_number(v) for v in row) if n is not None]
    if len(numbers) > DATA_COL_COUNT:
        numbers = numbers[-DATA_COL_COUNT:]
    return numbers


def next_block_row(ws):
    """
    One blank row below the last row holding anything in C:M.

    Only the data columns decide what counts as occupied -- a title or note
    parked in column A would otherwise push every new block far down the sheet.
    An otherwise empty sheet starts at row 2, directly under the header.
    """
    last_col = FIRST_DATA_COL + DATA_COL_COUNT - 1
    for row in range(ws.max_row, 1, -1):
        if any(ws.cell(row=row, column=c).value not in (None, "")
               for c in range(FIRST_DATA_COL, last_col + 1)):
            return row + 2
    return 2


def append_blocks(excel_path, df):
    """
    Write each image's rows into C:M of the FIRST worksheet, appending below
    whatever is already there and leaving one blank row between images.

    Returns (written, skipped) where written is [(image, first_row, last_row)].
    Nothing else on the sheet is touched, and the workbook's other tabs are
    left alone -- openpyxl edits in place rather than rewriting the file the
    way a pandas ExcelWriter round-trip does.
    """
    wb = openpyxl.load_workbook(excel_path)
    ws = wb[wb.sheetnames[0]]

    written, skipped = [], []
    data_cols = [c for c in df.columns if c not in META_COLS]

    group_key = "Source Image" if "Source Image" in df.columns else None
    groups = df.groupby(group_key, sort=False) if group_key else [("edited rows", df)]

    for image_name, group in groups:
        rows, partial = [], []
        for n, (_, r) in enumerate(group[data_cols].iterrows(), start=1):
            values = row_values(r.tolist())
            if len(values) == DATA_COL_COUNT:
                rows.append(values)
            elif values:
                # Short of a full row: usually one cell blanked or mistyped in
                # the review table. Named individually so it can be found.
                partial.append(f"row {n} has {len(values)} of {DATA_COL_COUNT}")

        if len(rows) != ROWS_PER_IMAGE:
            reason = f"{len(rows)} complete rows, expected {ROWS_PER_IMAGE}"
            if partial:
                reason += " (" + "; ".join(partial) + ")"
            skipped.append((image_name, reason))
            continue

        start = next_block_row(ws)
        for i, values in enumerate(rows):
            for j, value in enumerate(values[:DATA_COL_COUNT]):
                ws.cell(row=start + i, column=FIRST_DATA_COL + j, value=value)
        written.append((image_name, start, start + len(rows) - 1))

    wb.save(excel_path)
    return written, skipped


def read_data_block(excel_path):
    """The current contents of C:M on the first worksheet, for display."""
    wb = openpyxl.load_workbook(excel_path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    last_col = FIRST_DATA_COL + DATA_COL_COUNT - 1
    header = [ws.cell(row=1, column=c).value for c in range(FIRST_DATA_COL, last_col + 1)]
    header = [h if h else chr(ord("C") + i) for i, h in enumerate(header)]
    rows = [
        [ws.cell(row=r, column=c).value for c in range(FIRST_DATA_COL, last_col + 1)]
        for r in range(2, ws.max_row + 1)
    ]
    return pd.DataFrame(rows, columns=header)


st.set_page_config(page_title="Table OCR to Excel", layout="wide")
st.title("SCL Table -> Excel")
st.caption(
    "Upload your reference Excel file and your SCL screenshots. Each table is "
    "read by a vision model and written into columns C:M of the first "
    "worksheet, six rows per image with one blank row between. The workbook is "
    "edited in place and kept on disk, so it is still here next time."
)

# Stop here with an explanation rather than failing on the first screenshot.
_missing = model_ready()
if _missing:
    st.error(_missing)
    st.stop()

log = load_log()

# ---------------------------------------------------------------------------
# 1. Excel file
# ---------------------------------------------------------------------------
st.header("1. Excel file")
existing_excel = list(EXCEL_DIR.glob("*.xlsx"))
excel_path = existing_excel[0] if existing_excel else None

if excel_path:
    c1, c2 = st.columns([4, 1])
    c1.success(f"Stored Excel file: **{excel_path.name}**")
    if c2.button("Remove"):
        excel_path.unlink()
        st.rerun()
else:
    up_excel = st.file_uploader("Upload Excel file (.xlsx)", type=["xlsx"])
    if up_excel is not None:
        excel_path = EXCEL_DIR / up_excel.name
        excel_path.write_bytes(up_excel.getbuffer())
        st.rerun()

# ---------------------------------------------------------------------------
# 2. Image folder
# ---------------------------------------------------------------------------
st.header("2. Image folder")
st.caption(
    "Streamlit can't attach a whole folder directly — select all the image "
    "files inside your folder (Ctrl/Cmd-click, or drag the whole selection) "
    "and they'll be stored here as if it were one folder."
)
uploaded_imgs = st.file_uploader(
    "Upload images", type=["png", "jpg", "jpeg"], accept_multiple_files=True
)
if uploaded_imgs:
    new_count = 0
    for f in uploaded_imgs:
        dest = IMAGES_DIR / f.name
        if not dest.exists():
            dest.write_bytes(f.getbuffer())
            new_count += 1
    if new_count:
        st.success(f"Saved {new_count} new image(s) to the stored folder.")
        st.rerun()

stored_images = sorted(IMAGES_DIR.glob("*"))
st.write(f"**{len(stored_images)}** image(s) currently stored.")
if stored_images:
    with st.expander("Show stored image names"):
        for img in stored_images:
            tag = "processed" if img.name in log.get("processed_images", []) else "new"
            st.write(f"- {img.name}  _({tag})_")
    if st.button("Clear all stored images"):
        for img in stored_images:
            img.unlink()
        log["processed_images"] = []
        save_log(log)
        st.rerun()

processed = set(log.get("processed_images", []))
unprocessed = [p for p in stored_images if p.name not in processed]

# ---------------------------------------------------------------------------
# 3. Run OCR
# ---------------------------------------------------------------------------
st.header("3. Extract tables")
col1, col2 = st.columns(2)
run_new = col1.button(
    f"Process new images ({len(unprocessed)})",
    disabled=not (excel_path and unprocessed),
)
run_all = col2.button(
    "Re-process ALL images", disabled=not (excel_path and stored_images)
)

if "preview_df" not in st.session_state:
    st.session_state.preview_df = None
if "targets_this_run" not in st.session_state:
    st.session_state.targets_this_run = []

if run_new or run_all:
    targets = stored_images if run_all else unprocessed
    frames, failures, suspect = [], [], []
    progress = st.progress(0.0, text="Reading tables...")
    for i, img_path in enumerate(targets):
        progress.progress(i / len(targets), text=f"Reading {img_path.name}...")
        try:
            df, title, problems = extract_table_from_image(str(img_path))
        except Exception as e:
            failures.append((img_path.name, str(e)))
            continue
        df.insert(0, "Source Image", img_path.name)
        df.insert(1, "Extracted At", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        frames.append(df)
        if problems:
            suspect.append((img_path.name, title, problems))
    progress.empty()

    if frames:
        st.session_state.preview_df = pd.concat(frames, ignore_index=True)
        # Only images that produced a table are eligible to be marked done.
        st.session_state.targets_this_run = [
            p.name for p in targets if p.name not in {n for n, _ in failures}
        ]
        st.success(f"Read {len(frames)} of {len(targets)} image(s). Review below, then save.")
    else:
        st.session_state.preview_df = None

    if failures:
        st.error(
            "Could not read these:\n\n"
            + "\n".join(f"- **{name}**: {why}" for name, why in failures)
        )

    # These checks are properties of stress linearization, not of one workbook,
    # so a failure means a number is wrong rather than that the model is
    # unusual. Shown as a warning so the value can be corrected below before it
    # reaches the sheet.
    if suspect:
        st.warning(
            "**Some numbers fail the consistency checks** — Membrane should equal "
            "Membrane+Bending (Center), and Bending (Inside) should be the negative "
            "of Bending (Outside). Check these against the screenshot before saving:"
        )
        for name, title, problems in suspect:
            with st.expander(f"{name}{f'  ({title})' if title else ''} — {len(problems)} issue(s)"):
                for p in problems:
                    st.write(f"- {p}")

# ---------------------------------------------------------------------------
# 4. Review + save into Excel
# ---------------------------------------------------------------------------
if st.session_state.preview_df is not None:
    st.subheader("Review extracted data before saving")
    st.caption(
        "Check the numbers against your screenshots and correct anything wrong "
        "here — this is the last point before they reach the workbook."
    )
    edited = st.data_editor(
        st.session_state.preview_df, use_container_width=True, num_rows="dynamic"
    )

    if st.button("Save to Excel", type="primary"):
        try:
            written, skipped = append_blocks(excel_path, edited)
        except PermissionError:
            st.error(
                f"**{excel_path.name} could not be written.** If it is open in "
                "Excel somewhere, close it and press Save again."
            )
        except Exception as e:
            st.error(f"**Could not write to {excel_path.name}:** {e}")
        else:
            if written:
                st.success(
                    f"Written into **{excel_path.name}**, columns C:M of "
                    f"'{openpyxl.load_workbook(excel_path).sheetnames[0]}':\n\n"
                    + "\n".join(f"- {name} -> rows {a}-{b}" for name, a, b in written)
                )
                # Only images that actually landed are marked done, so a
                # rejected one is retried rather than silently lost.
                saved_names = {name for name, _, _ in written}
                processed.update(n for n in st.session_state.targets_this_run if n in saved_names)
                log["processed_images"] = sorted(processed)
                save_log(log)

            if skipped:
                st.warning(
                    "Not written — each image must give exactly "
                    f"{ROWS_PER_IMAGE} rows of {DATA_COL_COUNT} numbers:\n\n"
                    + "\n".join(f"- **{name}**: {why}" for name, why in skipped)
                    + "\n\nFix the rows above and press Save again."
                )

            if written:
                st.session_state.preview_df = None
                st.session_state.targets_this_run = []
                st.rerun()

# ---------------------------------------------------------------------------
# 5. Current extracted data + download
# ---------------------------------------------------------------------------
st.header("4. The workbook")
if excel_path and excel_path.exists():
    st.caption(
        f"This is **{excel_path.name}** itself — columns C:M of its first "
        "worksheet, read back from the stored file. Saving edits it in place, "
        "so there is no need to download it to keep your data; download only "
        "when you want a copy on your own machine."
    )
    current = read_data_block(excel_path)
    if current.dropna(how="all").empty:
        st.info("Nothing written into C:M yet.")
    else:
        st.dataframe(current)

    st.download_button(
        "Download a copy",
        data=excel_path.read_bytes(),
        file_name=excel_path.name,
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
else:
    st.info("Upload an Excel file above to get started.")
