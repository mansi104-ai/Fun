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

Everything lives under `app_data/` next to `app.py`:
- `app_data/excel/` — the Excel file
- `app_data/images/` — all uploaded images
- `app_data/processed_log.json` — which images have already been OCR'd

As long as this folder isn't deleted, your data survives app restarts and
new browser sessions — no accounts needed.

## Notes / limitations

- OCR accuracy depends heavily on image resolution and how clean the grid
  lines are. Dense tables (like small stress-result screenshots) may need
  manual correction in the review step.
- To start over completely, delete the `app_data/` folder.
