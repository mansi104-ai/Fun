# SCL Excel Extractor

Reads SCL (Stress Classification Line) result-table screenshots — like ANSYS's
"SCL-N" worksheet view — from a folder, and writes the 6 rows x 11 columns of
data (SX, SY, SZ, SXY, SYZ, SXZ, S1, S2, S3, SINT, SEQV) into the **C:M**
columns of the **first worksheet** of your reference Excel file.

It picks up where the data already ends (or the next pre-numbered empty
block, if your workbook already has SCL numbers filled in down column A),
keeps a running history of every file it has processed, and skips files it
has already handled so you can just keep dropping new screenshots into the
same folder.

## 1. One-time setup

1. Install Python 3.9+ if you don't have it: https://www.python.org/downloads/
   (On Windows, tick "Add Python to PATH" during install.)
2. Install **Tesseract OCR** (the engine that reads the text in the images):
   - Windows: https://github.com/UB-Mannheim/tesseract/wiki — install it, then
     note the install path (usually `C:\Program Files\Tesseract-OCR\tesseract.exe`).
   - Mac: `brew install tesseract`
   - Linux: `sudo apt install tesseract-ocr`
3. Open a terminal / command prompt in this folder and run:
   ```
   pip install -r requirements.txt
   ```
4. If you're on Windows and step 2 didn't add Tesseract to your PATH, run:
   ```
   python run.py set-tesseract "C:\Program Files\Tesseract-OCR\tesseract.exe"
   ```
   (Only needed once — it's saved in `config.json`.)

## 2. Point it at your folder and workbook

```
python run.py set-folder "C:\path\to\your\screenshots"
python run.py set-excel  "C:\path\to\your\reference.xlsx"
```

You can change either of these at any time — just run the same commands
again with a new path, or use option 2 / 3 in the menu (see below).

## 3. Run it

You have two options:

### Option A — Streamlit web UI (recommended)

```
streamlit run app.py
```

This opens a browser tab with a simple UI. There are two modes, switchable
at the top of the page:

- **Upload files** — upload the reference Excel workbook and one or more
  screenshots, click **Process images**, then click **Download updated
  workbook**. This works both locally and if you deploy the app (e.g. to
  Streamlit Community Cloud) — nothing is read from or written to any local
  folder.
- **Local folder (this machine only)** — same behavior as the command-line
  tool: point at a folder and an Excel file by path, and it reads/writes
  those files directly on disk. Only works when you're running the app on
  your own computer (not a hosted deployment).

Either mode shows a **Processing history** panel (from the workbook's
`Processing_History` tab) and a live summary of what was processed, skipped,
or flagged for review.

**Deploying to Streamlit Community Cloud:** push this folder to a GitHub
repo and point Streamlit Cloud at `app.py`. The included `packages.txt`
tells Streamlit Cloud to install Tesseract OCR automatically — no manual
setup needed on their end. Use **Upload files** mode there, since a hosted
app has no access to your local drive.

### Option B — Command line

Double-click **run.bat** (Windows) or **run.sh** (Mac/Linux), or from a
terminal:

```
python run.py
```

This opens a small menu:

```
1) Process new images now
2) Change reference image folder
3) Change reference Excel file
4) View processing history
5) Set custom Tesseract-OCR path
6) Exit
```

Pick **1** to scan the folder and fill in the workbook. You can also skip
straight to processing with `python run.py process`.

## What it does with each image

- Reads the 6-row table (Membrane / Bending (Inside) / Bending (Outside) /
  Membrane+Bending (Inside) / Membrane+Bending (Center) / Membrane+Bending
  (Outside)) and its 11 numeric columns.
- Checks the workbook's first sheet for the next open spot: if some SCL
  blocks are already filled in, it continues **beneath** the last filled
  block (or into the next pre-numbered empty block, if your template already
  has SCL numbers listed down column A).
- Writes only into columns **C through M** — nothing else on the sheet is
  touched, and the other 6+ tabs in the workbook are left completely alone.
- Logs every file it touches — filename, source folder, detected SCL title,
  which rows it wrote, and a status — to a **`Processing_History`** tab it
  adds to the same workbook. This is what makes re-runs safe: a file that's
  already logged as `OK` is skipped next time, even if you run it again.
- If an image can't be read confidently (e.g. a blurry screenshot, or the
  table layout doesn't match), it's **not** written to the data columns —
  it's logged with status `NEEDS REVIEW` and the reason, so you can check it
  by hand rather than risk bad numbers in the sheet.
- It also does a quick sanity check that your workbook's C1:M1 headers still
  read SX, SY, SZ, SXY, SYZ, SXZ, S1, S2, S3, SINT, SEQV, and warns you if
  they don't line up — useful if you ever point it at a differently laid
  out workbook.

## Notes and limitations

- Works best on clean screen-captures like the sample you provided (crisp
  rendered text, not a photo of a screen). Very low-resolution or heavily
  compressed images will read less reliably.
- Supported image types: `.png .jpg .jpeg .bmp .tif .tiff`.
- The tool assumes the table always has the same 6 rows in the same order.
  If a screenshot's table is laid out differently, it will likely get
  flagged as `NEEDS REVIEW` rather than write incorrect data.
- Everything runs locally on your machine — no data leaves your computer.
- `config.json` (created after your first `set-folder` / `set-excel`) just
  stores the two paths in plain text, so you can also edit it directly if
  you prefer.

## Files in this folder

| File | Purpose |
|---|---|
| `app.py` | Streamlit web UI |
| `run.py` | Command-line menu / entry point |
| `scl_core.py` | Extraction and Excel-writing logic (shared by both) |
| `config.json` | Your saved folder + Excel paths (created on first use) |
| `run.bat` / `run.sh` | Double-click launchers for the CLI, Windows / Mac-Linux |
| `requirements.txt` | Python packages to install |
| `packages.txt` | System package (Tesseract) for Streamlit Cloud deployment |
