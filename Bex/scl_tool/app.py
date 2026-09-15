"""
SCL screenshots -> the C:M columns of a workbook's first worksheet.

Everything is read on the machine running the app: the table is found with
classical computer vision and each cell is read by matching its pixels
against the ANSYS font's own glyph shapes, with no model, no API key and
nothing sent anywhere. Tesseract is only a fallback for cells that don't
match, and those are flagged for checking.

It runs in one of two places, and step four -- saving the workbook -- differs
between them because of what each can reach:

  * On your laptop (Run SCL Tool.bat): the workbook is chosen by its path and
    saved back to that path in place. Nothing to download.
  * Hosted on Streamlit Community Cloud: the app runs on Streamlit's server,
    which cannot see your disk. The workbook is uploaded instead, written to
    in memory, and handed back with a download button.
"""

import io
import os
import tempfile
from pathlib import Path

import pandas as pd
import streamlit as st

import local_config
from excel_write import ROWS_PER_BLOCK, append_blocks, describe_target
from table_read import COLUMNS, SUBTYPES, TableNotFound, read_table

IMAGE_TYPES = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"]
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Community Cloud checks every app out under /mount/src. SCL_HOSTED=1 forces
# hosted mode anywhere else, e.g. to try it locally.
HOSTED = (
    os.environ.get("SCL_HOSTED") == "1"
    or Path(__file__).resolve().as_posix().startswith("/mount/src/")
)

st.set_page_config(page_title="SCL Table to Excel", layout="wide")
st.title("SCL Table \u2192 Excel")
st.caption(
    "Drop in the SCL screenshots and your workbook. Each table is cut away "
    "from its graph, read cell by cell, and written into columns C:M of the "
    "first worksheet \u2014 six rows per screenshot, one blank row between."
)


def browse_for_excel():
    """
    Open the machine's own file picker and return the chosen path.

    A browser upload hands over the bytes but never the path, and the path is
    exactly what is needed to save the workbook back where it came from. The
    dialog opens on the machine running the app, so it is only offered locally.
    """
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return None
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    chosen = filedialog.askopenfilename(
        title="Select the reference workbook",
        filetypes=[("Excel workbook", "*.xlsx *.xlsm"), ("All files", "*.*")],
    )
    root.destroy()
    return chosen or None


def hosted_workbook(upload):
    """
    The uploaded workbook as a file on the server, kept for this session.

    openpyxl works on a path, so the upload is written into a per-session temp
    folder. It is replaced only when a different file is uploaded: after a
    write, the uploader still holds the original, and reloading that would
    silently throw the new blocks away.
    """
    if "workdir" not in st.session_state:
        st.session_state.workdir = tempfile.mkdtemp(prefix="scl_")
    path = Path(st.session_state.workdir) / Path(upload.name).name
    if st.session_state.get("source_id") != upload.file_id:
        path.write_bytes(upload.getvalue())
        st.session_state.source_id = upload.file_id
        st.session_state.written_here = []
    return path


# ---------------------------------------------------------------------------
# 1. The two inputs, side by side: screenshots on the left, workbook on the right
# ---------------------------------------------------------------------------
images_column, excel_column = st.columns(2)

with images_column:
    st.subheader("Screenshots")
    uploads = st.file_uploader(
        "SCL screenshots", type=IMAGE_TYPES, accept_multiple_files=True,
        label_visibility="collapsed",
    )
    st.caption(
        "Select every screenshot at once (Ctrl-click, or drag the whole "
        "selection in). Only the table is used \u2014 the graph is never read."
    )

excel_path = None
with excel_column:
    st.subheader("Excel file")
    if HOSTED:
        workbook_upload = st.file_uploader(
            "Excel workbook", type=["xlsx", "xlsm"], label_visibility="collapsed",
        )
        st.caption(
            "This copy of the app runs on Streamlit's server, which cannot see "
            "your laptop. The workbook is updated here and handed back for you "
            "to download over the original."
        )
        if workbook_upload is not None:
            excel_path = hosted_workbook(workbook_upload)
    else:
        stored_path = local_config.get("excel_path", "")
        if st.button("Browse\u2026", help="Opens this machine's file picker"):
            picked = browse_for_excel()
            if picked:
                local_config.set_value("excel_path", picked)
                st.rerun()
        typed = st.text_input(
            "Workbook path", value=stored_path,
            placeholder="C:\\Users\\you\\Documents\\reference.xlsx",
            label_visibility="collapsed",
        )
        if typed != stored_path:
            local_config.set_value("excel_path", typed)
            st.rerun()
        st.caption(
            "The full path to the workbook on this machine. It is edited and "
            "saved in place, so the file never moves and there is nothing to "
            "download."
        )
        if typed:
            excel_path = Path(typed)

excel_ready = bool(excel_path and excel_path.is_file())

with excel_column:
    if excel_path is None:
        st.info("Choose the workbook to write into.")
    elif not excel_ready:
        st.error(f"No file at that path: `{excel_path}`")
    else:
        try:
            sheet_name, landing_row = describe_target(excel_path)
        except Exception as e:
            st.error(f"Could not open the workbook: {e}")
            excel_ready = False
        else:
            st.success(
                f"**{excel_path.name}** \u2014 first worksheet *{sheet_name}*; "
                f"the next block lands on row **{landing_row}**."
            )

# A screenshot already written into this workbook would otherwise be appended
# a second time without complaint. Locally that is remembered across runs;
# hosted, only for the workbook currently uploaded.
if excel_ready and uploads:
    if HOSTED:
        seen = set(st.session_state.get("written_here", []))
    else:
        seen = local_config.written_images(excel_path)
    already = seen & {u.name for u in uploads}
    if already:
        st.warning(
            "**Already written into this workbook once:** "
            + ", ".join(f"`{n}`" for n in sorted(already))
            + ". Reading them again will add a second copy of those blocks."
        )


# ---------------------------------------------------------------------------
# 2. Find each table and read it
# ---------------------------------------------------------------------------
st.divider()
if "results" not in st.session_state:
    st.session_state.results = []

if st.button(
    f"Extract {len(uploads)} table(s)" if uploads else "Extract tables",
    type="primary", disabled=not (uploads and excel_ready),
):
    results, progress = [], st.progress(0.0, text="Reading\u2026")
    for i, upload in enumerate(uploads):
        progress.progress(i / len(uploads), text=f"Reading {upload.name}\u2026")
        upload.seek(0)
        entry = {"name": upload.name}
        try:
            crop, entry["rows"], entry["unreadable"], entry["uncertain"] = read_table(upload)
        except TableNotFound as e:
            entry["error"] = f"No SCL table recognised: {e}."
        except Exception as e:
            entry["error"] = f"Could not read this image: {e}"
        else:
            preview = io.BytesIO()
            crop.save(preview, format="PNG")
            entry["crop"] = preview.getvalue()
        results.append(entry)
    progress.empty()
    st.session_state.results = results
    st.rerun()


# ---------------------------------------------------------------------------
# 3. Review, then write
# ---------------------------------------------------------------------------
results = st.session_state.results
if results:
    st.subheader("Review before writing")
    st.caption(
        "Each table is shown under the part of the screenshot it was read from. "
        "Correct anything wrong here \u2014 this is the last point before the "
        "numbers reach the workbook."
    )

    edited_blocks = []
    for entry in results:
        name = entry["name"]
        label = name
        if entry.get("error"):
            label += "  \u2014 not read"
        else:
            todo = len(entry.get("unreadable", [])) + len(entry.get("uncertain", []))
            if todo:
                label += f"  \u2014 {todo} cell(s) to check"

        with st.expander(label, expanded=len(results) == 1 or bool(entry.get("error"))):
            if entry.get("error"):
                st.error(entry["error"])
                continue

            st.image(entry["crop"], caption="What was read", width="stretch")

            # A cell that did not come back as a number is left empty rather
            # than guessed, and named here so it can be typed in below.
            if entry["unreadable"]:
                st.warning(
                    "These cells could not be read as a number \u2014 fill them in "
                    "from the image above:\n\n"
                    + "\n".join(
                        f"- {SUBTYPES[i]}, {COLUMNS[j]}"
                        + (f" (read as `{raw}`)" if raw else "")
                        for i, j, raw in entry["unreadable"]
                    )
                )

            # Cells whose pixels did not match the ANSYS font closely were read
            # by Tesseract instead. That reader guesses, so each is named here to
            # be checked, rather than trusted the way a shape match is.
            if entry.get("uncertain"):
                st.warning(
                    "These cells did not match the ANSYS font closely, so they "
                    "were read a less reliable way — check each against the "
                    "image above:\n\n"
                    + "\n".join(
                        f"- {SUBTYPES[i]}, {COLUMNS[j]}: read as `{value}`"
                        for i, j, value in entry["uncertain"]
                    )
                )

            frame = pd.DataFrame(entry["rows"], columns=COLUMNS)
            frame.insert(0, "Subtype", SUBTYPES)
            # "plain" shows every digit that was read. Streamlit's default
            # display rounds floats to four decimals, which made -0.13152 look
            # like -0.1315 here even though the full value reached the sheet.
            edited = st.data_editor(
                frame, width="stretch", hide_index=True, key=f"editor_{name}",
                column_config={
                    "Subtype": st.column_config.TextColumn(disabled=True),
                    **{c: st.column_config.NumberColumn(format="plain") for c in COLUMNS},
                },
            )
            edited_blocks.append((name, edited[COLUMNS].values.tolist()))

    st.divider()
    # Hosted, the original is still on the laptop -- that is the backup.
    make_backup = False if HOSTED else st.checkbox(
        "Copy the workbook beside itself before writing", value=True,
        help="Saving rewrites the whole file. The copy makes a bad save undoable.",
    )

    target_name = excel_path.name if excel_ready else "the workbook"
    if st.button(
        f"Write {len(edited_blocks)} block(s) into {target_name}",
        type="primary", disabled=not (edited_blocks and excel_ready),
    ):
        try:
            written, skipped, backup = append_blocks(excel_path, edited_blocks, make_backup)
        except PermissionError:
            st.error(
                f"**{excel_path.name} could not be written.** It is most likely "
                "open in Excel \u2014 close it and press the button again."
            )
        except Exception as e:
            st.error(f"**Could not write to {excel_path.name}:** {e}")
        else:
            if written:
                sheet_name, _ = describe_target(excel_path)
                where = excel_path.name if HOSTED else excel_path
                st.success(
                    f"Written into **{where}**, columns C:M of *{sheet_name}*:\n\n"
                    + "\n".join(f"- {name} \u2192 rows {a}\u2013{b}" for name, a, b in written)
                )
                if backup:
                    st.caption(f"Backup: `{backup.name}`")
                names = [name for name, _, _ in written]
                if HOSTED:
                    st.session_state.written_here = (
                        st.session_state.get("written_here", []) + names
                    )
                else:
                    local_config.record_written(excel_path, names)
                # Only the blocks that landed are cleared, so a rejected one
                # stays on screen to be fixed and written again.
                saved = set(names)
                st.session_state.results = [r for r in results if r["name"] not in saved]

            if skipped:
                st.warning(
                    f"Not written \u2014 each screenshot must give {ROWS_PER_BLOCK} "
                    "rows of 11 numbers:\n\n"
                    + "\n".join(f"- **{name}**: {why}" for name, why in skipped)
                    + "\n\nFill in the empty cells above and press the button again."
                )
            if written and not skipped:
                st.rerun()


# ---------------------------------------------------------------------------
# 4. Hosted only: hand the updated workbook back
# ---------------------------------------------------------------------------
if HOSTED and excel_ready and st.session_state.get("written_here"):
    st.divider()
    st.subheader("Download the updated workbook")
    st.caption(
        "Save it over the original on your laptop. It holds every block "
        "written in this session: "
        + ", ".join(f"`{n}`" for n in st.session_state.written_here) + "."
    )
    st.download_button(
        f"Download {excel_path.name}", data=excel_path.read_bytes(),
        file_name=excel_path.name, mime=XLSX_MIME, type="primary",
    )
