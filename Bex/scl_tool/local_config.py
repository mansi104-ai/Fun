"""
A small config file beside this script: the workbook path last used, and
which screenshots have already been written into which workbook.

This is a single-user tool on one laptop, so the store is a plain JSON file
with no accounts and no locking. config.json is gitignored -- it holds paths
on this machine, which mean nothing anywhere else.
"""

import json
from pathlib import Path

CONFIG_FILE = Path(__file__).parent / "config.json"


def load():
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except ValueError:
            # A truncated file shouldn't stop the tool starting; the worst
            # case is re-entering the key.
            return {}
    return {}


def save(config):
    CONFIG_FILE.write_text(json.dumps(config, indent=2), encoding="utf-8")


def get(key, default=None):
    return load().get(key, default)


def set_value(key, value):
    config = load()
    config[key] = value
    save(config)


def written_images(excel_path):
    """Screenshot names already written into this workbook."""
    return set(load().get("written", {}).get(str(excel_path), []))


def record_written(excel_path, names):
    config = load()
    written = config.setdefault("written", {})
    key = str(excel_path)
    written[key] = sorted(set(written.get(key, [])) | set(names))
    save(config)
