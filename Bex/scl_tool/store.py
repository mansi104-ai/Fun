"""
store.py
Server-side persistent storage for the hosted (Fly.io) deployment.

The hosted app cannot see your computer's disk, so the "reference folder" and
"reference Excel file" live on a Fly volume mounted at /data instead. That
volume survives machine restarts, redeploys and suspends, which is what makes
the processing history meaningful across sessions: the same workbook file is
reopened every time, so its Processing_History sheet keeps growing and
already-processed screenshots keep being skipped.

Layout:

    /data
      state.json              active folder + active workbook
      workbooks/<name>.xlsx   reference workbooks
      folders/<name>/...      screenshot folders

Locally (no SCL_DATA_DIR set) this falls back to ./scl_data next to the source,
so the same UI can be exercised on a laptop without Fly.
"""

import os
import re
import json
import shutil

import scl_core as core

STATE_FILE = "state.json"
WORKBOOKS_DIR = "workbooks"
FOLDERS_DIR = "folders"

DEFAULT_STATE = {"active_workbook": "", "active_folder": ""}


def data_dir():
    d = os.environ.get("SCL_DATA_DIR")
    if not d:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scl_data")
    os.makedirs(os.path.join(d, WORKBOOKS_DIR), exist_ok=True)
    os.makedirs(os.path.join(d, FOLDERS_DIR), exist_ok=True)
    return d


def safe_name(name):
    """
    Reduce a user-supplied folder or file name to something that cannot escape
    its parent directory. Names reach this from free-text inputs and from
    uploaded filenames, so "../../etc/whatever" has to collapse to a single
    harmless path segment rather than being trusted.
    """
    name = os.path.basename(str(name).strip().replace("\\", "/"))
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name)
    name = name.strip(". ")
    return name or "untitled"


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def load_state():
    path = os.path.join(data_dir(), STATE_FILE)
    state = dict(DEFAULT_STATE)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                state.update(json.load(f))
        except (ValueError, OSError):
            # A truncated state.json (e.g. the machine was killed mid-write)
            # should cost you your selection, not the whole app.
            pass
    return state


def save_state(state):
    path = os.path.join(data_dir(), STATE_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Workbooks
# ---------------------------------------------------------------------------

def workbooks_root():
    return os.path.join(data_dir(), WORKBOOKS_DIR)


def list_workbooks():
    return sorted(
        f for f in os.listdir(workbooks_root())
        if f.lower().endswith(".xlsx") and not f.startswith("~$")
    )


def workbook_path(name):
    return os.path.join(workbooks_root(), safe_name(name))


def save_workbook(name, data: bytes):
    name = safe_name(name)
    if not name.lower().endswith(".xlsx"):
        name += ".xlsx"
    path = os.path.join(workbooks_root(), name)
    with open(path, "wb") as f:
        f.write(data)
    return name


def delete_workbook(name):
    path = workbook_path(name)
    if os.path.isfile(path):
        os.remove(path)


# ---------------------------------------------------------------------------
# Screenshot folders
# ---------------------------------------------------------------------------

def folders_root():
    return os.path.join(data_dir(), FOLDERS_DIR)


def list_folders():
    return sorted(
        f for f in os.listdir(folders_root())
        if os.path.isdir(os.path.join(folders_root(), f))
    )


def folder_path(name):
    return os.path.join(folders_root(), safe_name(name))


def create_folder(name):
    name = safe_name(name)
    os.makedirs(os.path.join(folders_root(), name), exist_ok=True)
    return name


def delete_folder(name):
    path = folder_path(name)
    if os.path.isdir(path):
        shutil.rmtree(path)


def list_images(name):
    path = folder_path(name)
    if not os.path.isdir(path):
        return []
    return sorted(
        f for f in os.listdir(path)
        if os.path.splitext(f)[1].lower() in core.IMAGE_EXTENSIONS
    )


def save_images(folder, items):
    """
    items: iterable of {"name": str, "data": bytes}. Returns (saved, replaced).

    An upload whose name already exists overwrites it. That is deliberate: the
    history skips by *content* fingerprint, not filename, so re-uploading a
    genuinely identical screenshot is skipped at processing time anyway, while
    a corrected re-export under the same name is a file you do want to replace.
    """
    create_folder(folder)
    saved, replaced = [], []
    for item in items:
        fname = safe_name(item["name"])
        path = os.path.join(folder_path(folder), fname)
        if os.path.exists(path):
            replaced.append(fname)
        with open(path, "wb") as f:
            f.write(item["data"])
        saved.append(fname)
    return saved, replaced


def disk_usage():
    """(bytes_used, bytes_total) for the data volume, for the UI's capacity note."""
    total, used, _free = shutil.disk_usage(data_dir())
    return used, total
