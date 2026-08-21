"""
watch_server.py
Watches one folder for new SCL screenshots and appends each one to a reference
Excel workbook, with a small web interface at http://localhost:8765.

Started by the launcher (`SCL Watcher.bat`) that you drop into the folder
holding the screenshots -- the launcher passes its own directory as --folder,
so the folder is whichever one you put it in.

    python watch_server.py --folder "C:\\path\\to\\screenshots"

Why a local server and not a plain .html file: a page opened as file:// cannot
read a folder or write your workbook. The File System Access API that would
let it do so is only available on https:// or http://localhost, and even then
a browser-side xlsx library has to rewrite the entire workbook, which would put
the other tabs at risk. Serving the page from Python keeps openpyxl -- which
edits the sheet in place -- in charge of the file.
"""

import os
import io
import sys
import json
import time
import queue
import argparse
import threading
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import openpyxl

import scl_core as core

HERE = os.path.dirname(os.path.abspath(__file__))
UI_FILE = os.path.join(HERE, "watch_ui.html")

# Lives in the watched folder, so each folder remembers its own workbook and
# the pairing travels with the folder if you move or copy it.
STATE_FILE = ".scl_watch.json"

POLL_SECONDS = 2
MAX_EVENTS = 200


# ---------------------------------------------------------------------------
# Native file dialog, marshalled to the main thread
# ---------------------------------------------------------------------------

# tkinter is not thread-safe, and the HTTP handler runs on a worker thread. The
# request puts a job here; the main thread owns the dialog and posts the answer
# back. Doing it inline from the worker appears to work on Windows and then
# deadlocks unpredictably.
_dialog_requests = queue.Queue()


def request_file_dialog(timeout=180):
    answer = queue.Queue(maxsize=1)
    _dialog_requests.put(answer)
    try:
        return answer.get(timeout=timeout)
    except queue.Empty:
        return None


def serve_dialog_requests(stop_event):
    while not stop_event.is_set():
        try:
            answer = _dialog_requests.get(timeout=0.2)
        except queue.Empty:
            continue
        path = None
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askopenfilename(
                title="Choose the reference Excel workbook",
                filetypes=[("Excel workbook", "*.xlsx"), ("All files", "*.*")],
            )
            root.destroy()
        except Exception as e:
            print(f"[dialog] unavailable: {e}", file=sys.stderr)
        answer.put(path or None)


# ---------------------------------------------------------------------------
# Watcher
# ---------------------------------------------------------------------------

class Watcher:
    def __init__(self, folder):
        self.folder = os.path.abspath(folder)
        self.lock = threading.Lock()
        self.events = []
        self.excel_path = ""
        self.busy = False
        self.last_scan = None
        # filename -> (size, mtime) seen on the previous poll, used to tell a
        # finished file from one still being written.
        self.pending = {}
        # Filenames already dealt with this session, so a folder of 200 images
        # is not re-OCR'd every two seconds. The workbook's own history is
        # still the authority on what was actually written.
        self.handled = set()
        self._load_state()

    # -- state ------------------------------------------------------------
    @property
    def state_path(self):
        return os.path.join(self.folder, STATE_FILE)

    def _load_state(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as f:
                self.excel_path = json.load(f).get("excel_path", "")
        except (OSError, ValueError):
            self.excel_path = ""

    def _save_state(self):
        tmp = self.state_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"excel_path": self.excel_path}, f, indent=2)
            os.replace(tmp, self.state_path)
        except OSError as e:
            self.log("-", "ERROR", f"Could not save settings: {e}")

    def set_excel(self, path):
        path = os.path.abspath(path.strip('" ')) if path.strip() else ""
        if path and not os.path.isfile(path):
            return False, f"No file at {path}"
        if path and not path.lower().endswith(".xlsx"):
            return False, "Needs to be an .xlsx file."
        with self.lock:
            self.excel_path = path
            self._save_state()
            # A new workbook means anything skipped for being already-written
            # deserves another look against this one.
            self.handled.clear()
        self.log("-", "INFO", f"Reference workbook set to {os.path.basename(path)}" if path else "Workbook detached.")
        return True, ""

    # -- logging ----------------------------------------------------------
    def log(self, filename, status, detail):
        with self.lock:
            self.events.insert(0, {
                "time": datetime.now().strftime("%H:%M:%S"),
                "file": filename,
                "status": status,
                "detail": detail,
            })
            del self.events[MAX_EVENTS:]

    # -- scanning ---------------------------------------------------------
    def candidates(self):
        """Image files that are new to this session and have stopped changing."""
        try:
            names = sorted(os.listdir(self.folder))
        except OSError:
            return []

        ready = []
        for name in names:
            if os.path.splitext(name)[1].lower() not in core.IMAGE_EXTENSIONS:
                continue
            if name in self.handled:
                continue
            full = os.path.join(self.folder, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            sig = (st.st_size, st.st_mtime)
            # A screenshot dropped in by a copy or a save dialog can be caught
            # half-written. Require the size and mtime to be unchanged across
            # two polls before touching it.
            if self.pending.get(name) == sig:
                ready.append(name)
            else:
                self.pending[name] = sig
        return ready

    def scan_once(self):
        with self.lock:
            excel_path = self.excel_path
            if self.busy:
                return
            self.busy = True
        try:
            self.last_scan = datetime.now().strftime("%H:%M:%S")
            new_files = self.candidates()
            if not new_files:
                return
            if not excel_path:
                for name in new_files:
                    self.log(name, "WAITING", "Waiting for a reference workbook to be attached.")
                    self.handled.add(name)
                return
            if not os.path.isfile(excel_path):
                self.log("-", "ERROR", f"Reference workbook is missing: {excel_path}")
                return
            self._process(new_files, excel_path)
        finally:
            with self.lock:
                self.busy = False

    def _process(self, names, excel_path):
        items = []
        for name in names:
            try:
                with open(os.path.join(self.folder, name), "rb") as f:
                    items.append({"name": name, "data": f.read()})
            except OSError as e:
                self.log(name, "ERROR", f"Could not read: {e}")
                self.handled.add(name)

        if not items:
            return

        try:
            wb = openpyxl.load_workbook(excel_path)
        except Exception as e:
            self.log("-", "ERROR", f"Could not open the workbook: {e}")
            return

        summary = core.process_workbook(wb, items, source_label=self.folder)

        try:
            wb.save(excel_path)
        except PermissionError:
            # Almost always the workbook being open in Excel. Nothing was
            # written, and nothing is marked handled, so the next scan retries
            # these same files once the file is released.
            self.log(
                "-", "LOCKED",
                f"{os.path.basename(excel_path)} is open in Excel -- close it and these "
                f"{len(items)} file(s) will be written on the next scan.",
            )
            return
        except Exception as e:
            self.log("-", "ERROR", f"Could not save the workbook: {e}")
            return

        for name, start, end in summary["processed"]:
            self.handled.add(name)
            self.log(name, "OK", f"Written to rows {start}-{end}.")
        for name in summary["skipped"]:
            self.handled.add(name)
            self.log(name, "SKIPPED", "Already recorded in this workbook's history.")
        for name, warnings in summary["flagged"]:
            self.handled.add(name)
            self.log(name, "NEEDS REVIEW", "; ".join(warnings) or "Could not read the table confidently.")
        for w in summary["header_warnings"]:
            self.log("-", "INFO", w)

    def run(self, stop_event):
        while not stop_event.is_set():
            try:
                self.scan_once()
            except Exception as e:
                self.log("-", "ERROR", f"Scan failed: {e}")
            stop_event.wait(POLL_SECONDS)

    # -- reporting --------------------------------------------------------
    def history_rows(self):
        if not self.excel_path or not os.path.isfile(self.excel_path):
            return []
        try:
            wb = openpyxl.load_workbook(self.excel_path, data_only=True)
        except Exception:
            return []
        if core.HISTORY_SHEET_NAME not in wb.sheetnames:
            return []
        ws = wb[core.HISTORY_SHEET_NAME]
        rows = [
            ["" if v is None else str(v) for v in row]
            for row in ws.iter_rows(min_row=2, values_only=True)
        ]
        return rows[::-1][:100]

    def snapshot(self):
        with self.lock:
            excel = self.excel_path
            events = list(self.events)
        images = [
            n for n in sorted(os.listdir(self.folder))
            if os.path.splitext(n)[1].lower() in core.IMAGE_EXTENSIONS
        ] if os.path.isdir(self.folder) else []
        return {
            "folder": self.folder,
            "excel_path": excel,
            "excel_name": os.path.basename(excel) if excel else "",
            "excel_exists": bool(excel) and os.path.isfile(excel),
            "image_count": len(images),
            "handled_count": len(self.handled),
            "last_scan": self.last_scan,
            "events": events,
            "nearby_workbooks": self.nearby_workbooks(),
        }

    def nearby_workbooks(self):
        """.xlsx files sitting in the watched folder or its parent -- usually
        where the reference workbook already is, saving a trip to the dialog."""
        found = []
        for d in (self.folder, os.path.dirname(self.folder)):
            try:
                for n in sorted(os.listdir(d)):
                    if n.lower().endswith(".xlsx") and not n.startswith("~$"):
                        full = os.path.join(d, n)
                        if full not in found:
                            found.append(full)
            except OSError:
                continue
        return found[:20]


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def make_handler(watcher):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # the console is for the watcher's own output

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj))

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                try:
                    with open(UI_FILE, "rb") as f:
                        self._send(200, f.read(), "text/html; charset=utf-8")
                except OSError:
                    self._send(500, b"watch_ui.html is missing", "text/plain")
            elif self.path == "/api/state":
                self._json(watcher.snapshot())
            elif self.path == "/api/history":
                self._json({"headers": core.HISTORY_HEADERS, "rows": watcher.history_rows()})
            else:
                self._send(404, b"not found", "text/plain")

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                payload = {}

            if self.path == "/api/excel":
                ok, err = watcher.set_excel(payload.get("path", ""))
                self._json({"ok": ok, "error": err})
            elif self.path == "/api/browse":
                path = request_file_dialog()
                if path:
                    ok, err = watcher.set_excel(path)
                    self._json({"ok": ok, "error": err, "path": path})
                else:
                    self._json({"ok": False, "error": "No file chosen."})
            elif self.path == "/api/rescan":
                # Forget this session's skip-list so everything in the folder is
                # reconsidered; the workbook history still prevents duplicates.
                with watcher.lock:
                    watcher.handled.clear()
                    watcher.pending.clear()
                watcher.log("-", "INFO", "Rescanning the whole folder.")
                self._json({"ok": True})
            else:
                self._send(404, b"not found", "text/plain")

    return Handler


def pick_port(preferred):
    import socket
    for port in range(preferred, preferred + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found in range.")


def main():
    ap = argparse.ArgumentParser(description="Watch a folder of SCL screenshots.")
    ap.add_argument("--folder", default=os.getcwd(), help="Folder to watch (default: current directory).")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    folder = os.path.abspath(args.folder)
    if not os.path.isdir(folder):
        raise SystemExit(f"Not a folder: {folder}")

    watcher = Watcher(folder)

    # Must happen before any image is read. The Windows installer does not put
    # Tesseract on PATH, so without this every screenshot fails with a
    # "tesseract is not installed" error on a machine where it plainly is.
    tesseract = core.resolve_tesseract()
    if tesseract:
        print(f"Tesseract: {tesseract}")
    else:
        print("Tesseract: NOT FOUND -- images cannot be read until it is installed.")
        print("  Windows: https://github.com/UB-Mannheim/tesseract/wiki")
        watcher.log("-", "ERROR", "Tesseract OCR was not found on this machine. Images cannot be read.")

    port = pick_port(args.port)
    url = f"http://localhost:{port}/"

    stop = threading.Event()
    threading.Thread(target=watcher.run, args=(stop,), daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(watcher))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print(f"Watching: {folder}")
    if watcher.excel_path:
        print(f"Workbook: {watcher.excel_path}")
    else:
        print("Workbook: not attached yet -- choose one in the page.")
    print(f"Interface: {url}")
    print("Leave this window open. Ctrl+C to stop.")

    if not args.no_browser:
        webbrowser.open(url)

    try:
        # The main thread stays free to own the tkinter dialog.
        serve_dialog_requests(stop)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.shutdown()
        print("\nStopped.")


if __name__ == "__main__":
    main()
