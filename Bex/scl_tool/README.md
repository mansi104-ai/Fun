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

This opens a browser tab with a simple UI. There are three modes, switchable
at the top of the page:

- **Saved library** — the reference workbook and the screenshot folders are
  kept in a persistent data directory, so they survive restarts. Pick the
  active workbook and the active folder from dropdowns, drop screenshots into
  the folder, and click **Process new images now**. Because the same `.xlsx`
  file is reopened every time, its `Processing_History` tab keeps growing and
  screenshots that were already read stay skipped across sessions. This is the
  mode the hosted deployment exists for.
- **One-off upload** — upload a workbook and one or more screenshots, click
  **Process images**, then **Download updated workbook**. Nothing is kept
  afterwards.
- **Local folder (this machine only)** — same behavior as the command-line
  tool: point at a folder and an Excel file by path, and it reads/writes those
  files directly on disk. Hidden on a hosted deployment, which has no access
  to your drive.

Every mode shows a **Processing history** panel (from the workbook's
`Processing_History` tab) and a live summary of what was processed, skipped,
or flagged for review.

## 4. Hosted deployment (Fly.io)

The app is deployed at **https://bex-scl-tool.fly.dev/**.

A hosted app cannot see your computer's disk, so **Saved library** mode is the
one to use there: the reference workbook and the screenshot folders live on a
Fly volume mounted at `/data` rather than on your laptop. You upload
screenshots into a named folder once, and both the folder and the workbook are
still there next session, history and all.

To redeploy after changing the code:

```
cd Bex/scl_tool
fly deploy --ha=false
```

`--ha=false` matters: Streamlit keeps each session's state inside the process
serving it, so a second machine would be a second unshared copy of the app
rather than extra capacity.

The page is open: anyone with the URL can use it, and can download whichever
workbook is currently saved on the volume. If you ever want a password in front
of it, no code change is needed:

```
fly secrets set SCL_PASSWORD=your-password --app bex-scl-tool
```

Run `fly secrets unset SCL_PASSWORD` to go back to open.

**Streamlit Community Cloud** is an alternative host: push this folder to a
GitHub repo and point Streamlit Cloud at `app.py`. The included `packages.txt`
tells it to install Tesseract OCR automatically. Note that it gives you no
persistent disk, so only **One-off upload** mode is useful there.

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

## 5. What it does with each image

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

## 6. Notes and limitations

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

## 7. Files in this folder

| File | Purpose |
|---|---|
| `app.py` | Streamlit web UI |
| `run.py` | Command-line menu / entry point |
| `scl_core.py` | Extraction and Excel-writing logic (shared by both) |
| `store.py` | Persistent server-side storage for Saved library mode |
| `config.json` | Your saved folder + Excel paths (created on first use) |
| `run.bat` / `run.sh` | Double-click launchers for the CLI, Windows / Mac-Linux |
| `requirements.txt` | Python packages to install |
| `packages.txt` | System package (Tesseract) for Streamlit Cloud deployment |
| `Dockerfile` | Container image for the Fly.io deployment |
| `entrypoint.sh` | Fixes volume ownership, then drops privileges |
| `fly.toml` | Fly.io app config (volume, health check, scale-to-zero) |
| `.dockerignore` | Keeps the desktop launchers out of the image |
