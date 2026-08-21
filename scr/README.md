# Image Table OCR → Excel

Streamlit app: upload an Excel file + a folder of table screenshots, OCR each
image's table, and save the results into the Excel file (each row tagged
with its source image filename). No login. Data is saved to disk, so it's
still there the next time you open the app.

## Setup

```bash
# system dependency (OCR engine)
sudo apt-get install -y tesseract-ocr

pip install -r requirements.txt
```

## Run

```bash
streamlit run app.py
```

Open the URL Streamlit prints (usually http://localhost:8501).

## How it works

1. **Upload Excel** — stored in `app_data/excel/`. Only one file is kept at
   a time (use "Remove" to swap it).
2. **Upload images** — select all the image files from your folder at once
   (Streamlit can't take a folder path directly, but multi-select works the
   same way). They're stored in `app_data/images/` and remembered across
   sessions.
3. **Extract tables** — click "Process new images" to OCR only images you
   haven't run yet, or "Re-process ALL" to redo everything. Extraction uses
   OpenCV to detect the table grid lines and OCRs each cell individually;
   if no grid is found it falls back to plain OCR.
4. **Review** — OCR on screenshots is not perfect, especially small/blurry
   text. Fix any misread cells in the editable table before saving.
5. **Save** — writes into a sheet called `OCR_Extracted` in your Excel
   file, appending to whatever's already there. Each row includes
   `Source Image` and `Extracted At` columns.
6. **Download** — grab the updated Excel file at any time.

## Persistence

Three things are kept on disk:
- `excel/` — the Excel file
- `images/` — all uploaded images
- `processed_log.json` — which images have already been OCR'd

Where that disk is depends on how the app is running:

| Running on | Location | Survives a redeploy? |
|---|---|---|
| Your machine | `app_data/` next to `app.py` | Yes |
| Fly.io | `/data`, a mounted volume | **Yes** |
| Streamlit Community Cloud | `app_data/` in the container | **No** |

`SCL_DATA_DIR` selects the location; unset, it falls back to `app_data/`.

Community Cloud rebuilds its container from the repo every time you push, and
gives no disk to attach, so anything uploaded there is gone after the next
deploy and has to be re-uploaded. That is the reason for the Fly deployment
below — nothing else about the app differs.

## Deploying

### Fly.io (persistent — recommended)

```bash
cd scr
fly deploy --ha=false
```

The `Dockerfile` installs Tesseract and OpenCV's one system library, and
`fly.toml` mounts the `scl_ocr_data` volume at `/data`. `--ha=false` matters:
one volume attaches to one machine, and Streamlit keeps each session's state
in the process serving it, so a second machine would be a second unshared copy
of the app rather than extra capacity.

The machine suspends when nobody is using it and resumes in a second or two,
so it only costs while in use. The volume persists either way.

### Streamlit Community Cloud (no persistence)

Point it at `scr/app.py`. One gotcha: `packages.txt` must be in the **root of
the repository**, not in this folder — unlike `requirements.txt`, Community
Cloud does not search upwards from the app file for it. There is one at the
repo root listing `tesseract-ocr`; without it the app starts, imports
pytesseract, and then fails on the first image with `TesseractNotFoundError`.

## Notes / limitations

- OCR accuracy depends heavily on image resolution and how clean the grid
  lines are. Dense tables (like small stress-result screenshots) may need
  manual correction in the review step.
- To start over completely, delete the `app_data/` folder.
