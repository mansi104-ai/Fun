"""
app.py
Streamlit UI for the SCL Excel Extractor.

Run locally with:
    streamlit run app.py

Three ways to use it:
  - Saved library: the reference workbook and the screenshot folders live in a
    persistent data directory (a Fly volume when deployed, ./scl_data locally).
    Because the same workbook file is reopened every time, its
    Processing_History sheet accumulates across sessions and already-processed
    screenshots stay skipped. This is the mode the hosted deployment is for.
  - One-off upload: upload a workbook and some screenshots, process, download.
    Nothing is kept afterwards.
  - Local folder (hidden when hosted): point at a folder and an Excel file by
    path on this machine, same as the command-line tool.
"""

import io
import os
import hmac

import openpyxl
import pandas as pd
import streamlit as st

import scl_core as core
import store

st.set_page_config(page_title="SCL Excel Extractor", page_icon="\U0001F4CA", layout="wide")

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# Set by the container image (see Dockerfile).
HOSTED = os.environ.get("SCL_HOSTED") == "1"


# ---------------------------------------------------------------------------
# Access gate
# ---------------------------------------------------------------------------

def require_password():
    """
    Optional single shared password, read from the SCL_PASSWORD secret.

    Unset is the default and means no gate at all: the page is just the tool.
    Turning it on later needs no code change, only

        fly secrets set SCL_PASSWORD=... --app bex-scl-tool
    """
    expected = os.environ.get("SCL_PASSWORD", "")

    if not expected:
        return

    if st.session_state.get("authed"):
        return

    st.title("SCL Excel Extractor")
    pw = st.text_input("Password", type="password")
    if st.button("Sign in", type="primary"):
        # Constant-time compare: a plain == leaks the password's prefix through
        # response timing to anyone willing to measure it.
        if hmac.compare_digest(pw, expected):
            st.session_state["authed"] = True
            st.rerun()
        else:
            st.error("Incorrect password.")
    st.stop()


require_password()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_history_df(wb):
    if core.HISTORY_SHEET_NAME not in wb.sheetnames:
        return pd.DataFrame(columns=core.HISTORY_HEADERS)
    ws = wb[core.HISTORY_SHEET_NAME]
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    return pd.DataFrame(rows, columns=core.HISTORY_HEADERS)


def show_summary(summary):
    c1, c2, c3 = st.columns(3)
    c1.metric("Processed", len(summary["processed"]))
    c2.metric("Skipped (already done)", len(summary["skipped"]))
    c3.metric("Flagged for review", len(summary["flagged"]))

    if summary["header_warnings"]:
        with st.expander("⚠️ Header check warnings", expanded=False):
            for w in summary["header_warnings"]:
                st.write(f"- {w}")

    if summary["processed"]:
        st.success(
            "Written to the workbook:\n\n"
            + "\n".join(f"- **{f}** → rows {s}-{e}" for f, s, e in summary["processed"])
        )
    if summary["skipped"]:
        st.info("Already processed previously, skipped:\n\n" + "\n".join(f"- {f}" for f in summary["skipped"]))
    if summary["flagged"]:
        st.warning("Could not confidently read these — logged as NEEDS REVIEW, nothing written:")
        for fname, warnings in summary["flagged"]:
            st.write(f"**{fname}**")
            for w in warnings:
                st.caption(f"  {w}")


def show_history_from_workbook(path_or_buffer):
    with st.expander("Processing history", expanded=False):
        wb_preview = openpyxl.load_workbook(path_or_buffer, data_only=True)
        df = get_history_df(wb_preview)
        if df.empty:
            st.write("No history yet.")
        else:
            st.dataframe(df)


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

st.title("SCL Excel Extractor")
st.caption(
    "Reads SCL stress-classification screenshots and fills the SX-SEQV columns "
    "(C:M by default) of the first worksheet in your reference workbook, keeping "
    "a history of every file processed."
)

MODES = ["Saved library", "One-off upload"]
if not HOSTED:
    MODES.append("Local folder (this machine only)")

mode = st.radio(
    "Mode",
    MODES,
    horizontal=True,
    help="'Saved library' keeps your workbook and screenshot folders on the "
         "server between sessions. 'One-off upload' keeps nothing. "
         "'Local folder' reads/writes directly on this machine's disk.",
)

st.divider()

# ---------------------------------------------------------------------------
# Saved library mode (persistent)
# ---------------------------------------------------------------------------
if mode == "Saved library":
    state = store.load_state()
    workbooks = store.list_workbooks()
    folders = store.list_folders()

    col_wb, col_fd = st.columns(2)

    # ---- Reference workbook ----
    with col_wb:
        st.subheader("Reference Excel")
        if workbooks:
            active_wb = state.get("active_workbook", "")
            idx = workbooks.index(active_wb) if active_wb in workbooks else 0
            wb_choice = st.selectbox("Reference workbook", workbooks, index=idx)
        else:
            wb_choice = ""
            st.info("No workbook saved yet - upload one below.")

        wb_upload = st.file_uploader("Add or replace a workbook", type=["xlsx"], key="wb_up")
        if wb_upload is not None:
            sig = (wb_upload.name, wb_upload.size)
            if st.session_state.get("wb_up_sig") != sig:
                st.session_state["wb_up_sig"] = sig
                saved_name = store.save_workbook(wb_upload.name, wb_upload.getvalue())
                state["active_workbook"] = saved_name
                store.save_state(state)
                st.success(f"Saved **{saved_name}** and made it the reference workbook.")
                st.rerun()

    # ---- Reference folder ----
    with col_fd:
        st.subheader("Reference folder")
        if folders:
            active_fd = state.get("active_folder", "")
            idx = folders.index(active_fd) if active_fd in folders else 0
            fd_choice = st.selectbox("Screenshot folder", folders, index=idx)
        else:
            fd_choice = ""
            st.info("No folder yet - create one below.")

        new_folder = st.text_input("Create a new folder", placeholder="e.g. Nozzle-N1")
        if st.button("Create folder", disabled=not new_folder.strip()):
            created = store.create_folder(new_folder)
            state["active_folder"] = created
            store.save_state(state)
            st.success(f"Created folder **{created}**.")
            st.rerun()

    # Persist the current selection so it is still active next session.
    if wb_choice != state.get("active_workbook") or fd_choice != state.get("active_folder"):
        state["active_workbook"] = wb_choice
        state["active_folder"] = fd_choice
        store.save_state(state)

    st.divider()

    # ---- Screenshots in the active folder ----
    if fd_choice:
        st.subheader(f"Screenshots in {fd_choice}")

        img_upload = st.file_uploader(
            "Add screenshots to this folder",
            type=["png", "jpg", "jpeg", "bmp", "tif", "tiff"],
            accept_multiple_files=True,
            key="img_up",
        )
        if img_upload:
            sig = tuple((f.name, f.size) for f in img_upload)
            if st.session_state.get("img_up_sig") != sig:
                st.session_state["img_up_sig"] = sig
                saved, replaced = store.save_images(
                    fd_choice, [{"name": f.name, "data": f.getvalue()} for f in img_upload]
                )
                msg = f"Added {len(saved)} file(s) to **{fd_choice}**."
                if replaced:
                    msg += f" Replaced: {', '.join(replaced)}."
                st.success(msg)
                st.rerun()

        images = store.list_images(fd_choice)
        if images:
            st.caption(f"{len(images)} image(s) in this folder:")
            st.code("\n".join(images), language=None)
        else:
            st.caption("This folder is empty.")

    st.divider()

    ready = bool(wb_choice and fd_choice and store.list_images(fd_choice))
    if st.button("Process new images now", type="primary", disabled=not ready):
        cfg = {
            "image_folder": store.folder_path(fd_choice),
            "excel_path": store.workbook_path(wb_choice),
            "tesseract_cmd": "",
        }
        try:
            with st.spinner("Reading images and updating the workbook..."):
                # process_folder writes the workbook back to the volume, so the
                # updated data and the new history rows persist as one file.
                st.session_state["lib_summary"] = core.process_folder(cfg)
        except Exception as e:
            st.error(str(e))

    if "lib_summary" in st.session_state:
        show_summary(st.session_state["lib_summary"])

    if wb_choice:
        wb_path = store.workbook_path(wb_choice)
        if os.path.isfile(wb_path):
            with open(wb_path, "rb") as f:
                st.download_button(
                    "Download updated workbook",
                    data=f.read(),
                    file_name=wb_choice,
                    mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            st.caption(
                "The saved copy on the server is the one that keeps its history. "
                "Downloading takes a snapshot; it does not move the reference."
            )
            show_history_from_workbook(wb_path)

    with st.expander("Manage saved data", expanded=False):
        used, total = store.disk_usage()
        st.caption(f"Volume: {used / 1e6:.0f} MB used of {total / 1e6:.0f} MB.")
        d1, d2 = st.columns(2)
        with d1:
            if workbooks:
                to_del = st.selectbox("Delete a workbook", [""] + workbooks, key="del_wb")
                if st.button("Delete workbook", disabled=not to_del):
                    store.delete_workbook(to_del)
                    st.rerun()
        with d2:
            if folders:
                fd_del = st.selectbox("Delete a folder (and its images)", [""] + folders, key="del_fd")
                if st.button("Delete folder", disabled=not fd_del):
                    store.delete_folder(fd_del)
                    st.rerun()

# ---------------------------------------------------------------------------
# One-off upload mode
# ---------------------------------------------------------------------------
elif mode == "One-off upload":
    col1, col2 = st.columns(2)
    with col1:
        excel_file = st.file_uploader("Reference Excel workbook", type=["xlsx"])
    with col2:
        image_files = st.file_uploader(
            "Screenshot image(s)",
            type=["png", "jpg", "jpeg", "bmp", "tif", "tiff"],
            accept_multiple_files=True,
        )

    if excel_file is not None:
        key = f"{excel_file.name}-{excel_file.size}"
        if st.session_state.get("wb_key") != key:
            st.session_state["wb_key"] = key
            st.session_state["wb_bytes"] = excel_file.getvalue()
            st.session_state["wb_name"] = excel_file.name

    has_wb = "wb_bytes" in st.session_state

    process_clicked = st.button(
        "Process images",
        type="primary",
        disabled=not (has_wb and image_files),
    )

    if process_clicked:
        wb = openpyxl.load_workbook(io.BytesIO(st.session_state["wb_bytes"]))
        image_items = [{"name": f.name, "data": f.getvalue()} for f in image_files]
        with st.spinner("Reading images and updating the workbook..."):
            summary = core.process_workbook(wb, image_items, source_label="Uploaded via Streamlit")
        buf = io.BytesIO()
        wb.save(buf)
        st.session_state["wb_bytes"] = buf.getvalue()
        st.session_state["last_summary"] = summary

    if "last_summary" in st.session_state:
        show_summary(st.session_state["last_summary"])

    if has_wb:
        st.download_button(
            "Download updated workbook",
            data=st.session_state["wb_bytes"],
            file_name=st.session_state.get("wb_name", "updated.xlsx"),
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        st.caption(
            "Any formulas elsewhere in the workbook that depend on this data "
            "(other tabs, or other columns on this sheet) will recalculate "
            "automatically the next time you open the file in Excel."
        )
        show_history_from_workbook(io.BytesIO(st.session_state["wb_bytes"]))
    else:
        st.info("Upload a reference Excel workbook to get started.")

# ---------------------------------------------------------------------------
# Local folder mode (never reachable when hosted)
# ---------------------------------------------------------------------------
else:
    cfg = core.load_config(CONFIG_PATH)

    col1, col2 = st.columns(2)
    with col1:
        folder = st.text_input("Image folder path", value=cfg.get("image_folder", ""))
    with col2:
        excel_path = st.text_input("Reference Excel file path", value=cfg.get("excel_path", ""))

    tess_path = st.text_input(
        "Tesseract-OCR path override (optional, only if not on your system PATH)",
        value=cfg.get("tesseract_cmd", ""),
    )

    if st.button("Save settings"):
        cfg["image_folder"] = folder
        cfg["excel_path"] = excel_path
        cfg["tesseract_cmd"] = tess_path
        core.save_config(CONFIG_PATH, cfg)
        st.success("Settings saved.")

    st.divider()

    process_clicked = st.button("Process new images now", type="primary")

    if process_clicked:
        cfg["image_folder"] = folder
        cfg["excel_path"] = excel_path
        cfg["tesseract_cmd"] = tess_path
        try:
            with st.spinner("Scanning folder and updating the workbook..."):
                summary = core.process_folder(cfg)
            st.session_state["last_summary_local"] = summary
        except Exception as e:
            st.error(str(e))

    if "last_summary_local" in st.session_state:
        show_summary(st.session_state["last_summary_local"])

    if excel_path and os.path.isfile(excel_path):
        show_history_from_workbook(excel_path)
