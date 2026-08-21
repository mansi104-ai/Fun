import json
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st

from ocr_table import extract_table_from_image

# ---------------------------------------------------------------------------
# Persistent storage (plain files on disk next to this script -> survives
# app restarts / new browser sessions, no login/auth involved).
# ---------------------------------------------------------------------------
APP_DIR = Path(__file__).parent
DATA_DIR = APP_DIR / "app_data"
IMAGES_DIR = DATA_DIR / "images"
EXCEL_DIR = DATA_DIR / "excel"
LOG_FILE = DATA_DIR / "processed_log.json"
SHEET_NAME = "OCR_Extracted"

for d in (IMAGES_DIR, EXCEL_DIR):
    d.mkdir(parents=True, exist_ok=True)


def load_log() -> dict:
    if LOG_FILE.exists():
        return json.loads(LOG_FILE.read_text())
    return {"processed_images": []}


def save_log(log: dict) -> None:
    LOG_FILE.write_text(json.dumps(log, indent=2))


st.set_page_config(page_title="Table OCR to Excel", layout="wide")
st.title("Image Table OCR -> Excel")
st.caption(
    "Upload an Excel file and a folder of table screenshots. "
    "Extracted table data (with the source image name) is written into the "
    "Excel file. Everything is saved on disk, so it's still here next time "
    "you open the app."
)

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
    frames = []
    progress = st.progress(0.0, text="Running OCR...")
    for i, img_path in enumerate(targets):
        df = extract_table_from_image(str(img_path))
        if not df.empty:
            df.insert(0, "Source Image", img_path.name)
            df.insert(1, "Extracted At", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            frames.append(df)
        progress.progress((i + 1) / len(targets), text=f"OCR: {img_path.name}")
    progress.empty()

    if frames:
        st.session_state.preview_df = pd.concat(frames, ignore_index=True)
        st.session_state.targets_this_run = [p.name for p in targets]
        st.success(
            f"Extracted data from {len(frames)}/{len(targets)} image(s). "
            "Review below, then save."
        )
    else:
        st.warning("No table data could be detected in the selected images.")
        st.session_state.preview_df = None

# ---------------------------------------------------------------------------
# 4. Review + save into Excel
# ---------------------------------------------------------------------------
if st.session_state.preview_df is not None:
    st.subheader("Review extracted data before saving")
    st.caption("OCR isn't perfect — fix any misread cells here before saving.")
    edited = st.data_editor(
        st.session_state.preview_df, use_container_width=True, num_rows="dynamic"
    )

    if st.button("Save to Excel", type="primary"):
        try:
            existing = pd.read_excel(excel_path, sheet_name=SHEET_NAME)
            combined = pd.concat([existing, edited], ignore_index=True)
        except (ValueError, FileNotFoundError):
            combined = edited

        with pd.ExcelWriter(
            excel_path,
            engine="openpyxl",
            mode="a" if excel_path.exists() else "w",
            if_sheet_exists="replace",
        ) as writer:
            combined.to_excel(writer, sheet_name=SHEET_NAME, index=False)

        processed.update(st.session_state.targets_this_run)
        log["processed_images"] = sorted(processed)
        save_log(log)

        st.session_state.preview_df = None
        st.session_state.targets_this_run = []
        st.success(f"Saved into '{SHEET_NAME}' sheet of {excel_path.name}.")
        st.rerun()

# ---------------------------------------------------------------------------
# 5. Current extracted data + download
# ---------------------------------------------------------------------------
st.header("4. Extracted data & download")
if excel_path and excel_path.exists():
    try:
        current = pd.read_excel(excel_path, sheet_name=SHEET_NAME)
        st.dataframe(current, use_container_width=True)
    except ValueError:
        st.info("No data extracted into this Excel file yet.")

    st.download_button(
        "Download Excel file",
        data=excel_path.read_bytes(),
        file_name=excel_path.name,
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
else:
    st.info("Upload an Excel file above to get started.")
